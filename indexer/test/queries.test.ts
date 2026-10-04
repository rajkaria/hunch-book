// The example queries in indexer/queries/ only select and filter fields the schema has. The API is
// Hasura over the schema: one root field per entity (and <Entity>_by_pk), relations by their schema
// name, and the `<relation>_id` columns usable in filters.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DocumentNode,
  type FieldNode,
  Kind,
  type ObjectTypeDefinitionNode,
  parse,
  type SelectionSetNode,
  type TypeNode,
  type ValueNode,
} from "graphql";
import { describe, expect, it } from "vitest";
import { INDEXER_DIR } from "../scripts/gen-config.js";

interface FieldInfo {
  type: string;
  entity: boolean;
}

const schema = parse(readFileSync(join(INDEXER_DIR, "schema.graphql"), "utf8"));
const entities = new Map<string, Map<string, FieldInfo>>();
const objectTypes = schema.definitions.filter(
  (d): d is ObjectTypeDefinitionNode => d.kind === Kind.OBJECT_TYPE_DEFINITION,
);
const named = (t: TypeNode): string => (t.kind === Kind.NAMED_TYPE ? t.name.value : named(t.type));
for (const def of objectTypes) entities.set(def.name.value, new Map());
for (const def of objectTypes) {
  const fields = entities.get(def.name.value) as Map<string, FieldInfo>;
  for (const f of def.fields ?? []) {
    const type = named(f.type);
    fields.set(f.name.value, { type, entity: entities.has(type) });
  }
}

function fieldOf(entity: string, name: string): FieldInfo | undefined {
  const fields = entities.get(entity);
  if (!fields) return undefined;
  const direct = fields.get(name);
  if (direct) return direct;
  // Hasura exposes the stored foreign key of a relation as <relation>_id.
  if (name.endsWith("_id") && fields.get(name.slice(0, -3))?.entity) return { type: "String", entity: false };
  return undefined;
}

/** Checks a where or order_by literal: keys are fields, `_and`/`_or`/`_not`, or operators under scalar fields. */
function checkFilter(entity: string, value: ValueNode, path: string, errors: string[]): void {
  if (value.kind === Kind.LIST) {
    for (const v of value.values) checkFilter(entity, v, path, errors);
    return;
  }
  if (value.kind !== Kind.OBJECT) return; // a variable or a scalar
  for (const f of value.fields) {
    const key = f.name.value;
    if (key === "_and" || key === "_or" || key === "_not") {
      checkFilter(entity, f.value, path, errors);
      continue;
    }
    const field = fieldOf(entity, key);
    if (!field) {
      errors.push(`${path}: ${entity} has no field ${key}`);
      continue;
    }
    if (field.entity) checkFilter(field.type, f.value, `${path}.${key}`, errors);
  }
}

function checkSelection(entity: string, set: SelectionSetNode, path: string, errors: string[]): void {
  for (const sel of set.selections) {
    if (sel.kind !== Kind.FIELD) continue;
    const name = sel.name.value;
    if (name === "__typename") continue;
    const field = fieldOf(entity, name);
    if (!field) {
      errors.push(`${path}: ${entity} has no field ${name}`);
      continue;
    }
    checkArguments(field.entity ? field.type : entity, sel, `${path}.${name}`, errors);
    if (field.entity && !sel.selectionSet) errors.push(`${path}.${name}: relation needs a selection`);
    if (!field.entity && sel.selectionSet) errors.push(`${path}.${name}: scalar cannot have a selection`);
    if (field.entity && sel.selectionSet)
      checkSelection(field.type, sel.selectionSet, `${path}.${name}`, errors);
  }
}

function checkArguments(entity: string, field: FieldNode, path: string, errors: string[]): void {
  for (const arg of field.arguments ?? []) {
    if (arg.name.value === "where" || arg.name.value === "order_by")
      checkFilter(entity, arg.value, path, errors);
  }
}

function validate(doc: DocumentNode): string[] {
  const errors: string[] = [];
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const root = sel.name.value.replace(/_by_pk$/, "");
      if (!entities.has(root)) {
        errors.push(`${sel.name.value}: no entity ${root}`);
        continue;
      }
      checkArguments(root, sel, root, errors);
      if (!sel.selectionSet) errors.push(`${root}: needs a selection`);
      else checkSelection(root, sel.selectionSet, root, errors);
    }
  }
  return errors;
}

const dir = join(INDEXER_DIR, "queries");
const files = readdirSync(dir).filter((f) => f.endsWith(".graphql"));

describe("example queries", () => {
  it("covers the queries the app needs", () => {
    expect(files.sort()).toEqual([
      "auto-redeem.graphql",
      "market-detail.graphql",
      "markets.graphql",
      "open-orders.graphql",
      "portfolio.graphql",
      "proof-stats.graphql",
      "referrals.graphql",
      "rewards.graphql",
      "timelock.graphql",
      "trade-tape.graphql",
    ]);
  });

  it.each(files)("%s only uses fields the schema has", (file) => {
    const doc = parse(readFileSync(join(dir, file), "utf8"));
    expect(validate(doc)).toEqual([]);
  });

  it("catches a field the schema does not have", () => {
    const doc = parse("query { Market(where: { nope: { _eq: 1 } }) { id stakerz book { idd } } }");
    expect(validate(doc)).toEqual([
      "Market: Market has no field nope",
      "Market: Market has no field stakerz",
      "Market.book: Book has no field idd",
    ]);
  });
});
