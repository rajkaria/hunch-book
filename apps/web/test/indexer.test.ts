import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { describe, expect, it, vi } from "vitest";
import { type Fetcher, IndexerError, indexerUrl, makeIndexerClient } from "../src/lib/indexer/client";
import { ALL_QUERIES } from "../src/lib/indexer/queries";
import { fallbackReason, withIndexer } from "../src/lib/indexer/source";

// The indexer client against a fake fetch, the source picker, and every query the app sends checked
// against indexer/schema.graphql (Hasura: one root field per entity and <Entity>_by_pk, relations by
// name, and <relation>_id usable in filters).

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers each request with the next handler's result. */
function fakeFetch(...answers: ((init: RequestInit) => Response | Promise<Response>)[]) {
  const calls: { url: string; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    return answer(init);
  });
  return { fetch: fn as unknown as Fetcher, calls };
}

const URL_ = "https://indexer.example/v1/graphql";

describe("indexerUrl", () => {
  it("reads the testnet and mainnet endpoints, and ignores anything that is not http(s)", () => {
    const env = { testnet: ` ${URL_} `, mainnet: "ftp://nope" };
    expect(indexerUrl("monad-testnet", env)).toBe(URL_);
    expect(indexerUrl("monad-mainnet", env)).toBeNull();
    expect(indexerUrl("monad-testnet", {})).toBeNull();
    expect(indexerUrl("monad-testnet", { testnet: "not a url" })).toBeNull();
    // This build has no endpoint configured.
    expect(indexerUrl("monad-testnet")).toBeNull();
  });
});

describe("makeIndexerClient", () => {
  it("posts the query and variables and returns data", async () => {
    const f = fakeFetch(() => json({ data: { Market: [{ id: "0xa" }] } }));
    const client = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: f.fetch });
    const data = await client.query<{ Market: { id: string }[] }>("query { Market { id } }", { a: 1 });
    expect(data.Market[0]?.id).toBe("0xa");
    expect(f.calls[0]?.url).toBe(URL_);
    expect(f.calls[0]?.body).toEqual({ query: "query { Market { id } }", variables: { a: 1 } });
    expect(client.chainId).toBe(10143);
  });

  it("turns every failure into an IndexerError with a kind, then rests", async () => {
    let t = 1_000;
    const now = () => t;
    const cases: [IndexerError["kind"], () => Response | Promise<Response>][] = [
      ["http", () => new Response("bad gateway", { status: 502 })],
      ["graphql", () => json({ errors: [{ message: "field 'nope' not found" }] })],
      ["shape", () => new Response("<html>", { status: 200 })],
      ["shape", () => json({ data: null })],
      [
        "network",
        () => {
          throw new TypeError("Failed to fetch");
        },
      ],
    ];
    for (const [kind, answer] of cases) {
      const f = fakeFetch(answer);
      const client = makeIndexerClient({
        url: URL_,
        network: "monad-testnet",
        fetch: f.fetch,
        now,
        restMs: 500,
      });
      const error = await client.query("query { Market { id } }").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IndexerError);
      expect((error as IndexerError).kind).toBe(kind);
      expect(client.available()).toBe(false);
      t += 500;
      expect(client.available()).toBe(true);
    }
  });

  it("times out a request that hangs", async () => {
    const f = fakeFetch(
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const client = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: f.fetch, timeoutMs: 20 });
    const error = await client.query("query { Market { id } }").catch((e: unknown) => e);
    expect((error as IndexerError).kind).toBe("timeout");
  });

  it("reads the sync status from _meta, and caches it", async () => {
    const f = fakeFetch(() =>
      json({
        data: {
          _meta: [
            { chainId: 143, progressBlock: 5, sourceBlock: 9, isReady: true },
            { chainId: 10143, progressBlock: 68_000_000, sourceBlock: 68_000_010, isReady: true },
          ],
        },
      }),
    );
    const client = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: f.fetch });
    expect(await client.status()).toEqual({
      chainId: 10143,
      progressBlock: 68_000_000n,
      sourceBlock: 68_000_010n,
      isReady: true,
    });
    await client.status();
    expect(f.calls).toHaveLength(1);
  });

  it("treats an endpoint without _meta as status unknown, and another chain as wrong", async () => {
    const noMeta = fakeFetch(() =>
      json({ errors: [{ message: "field '_meta' not found in type: 'query_root'" }] }),
    );
    const a = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: noMeta.fetch });
    expect(await a.status()).toBeNull();
    expect(a.available()).toBe(true);

    const other = fakeFetch(() =>
      json({ data: { _meta: [{ chainId: 143, progressBlock: 1, sourceBlock: 1, isReady: true }] } }),
    );
    const b = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: other.fetch });
    const error = await b.status().catch((e: unknown) => e);
    expect((error as IndexerError).kind).toBe("wrong-chain");
  });
});

describe("withIndexer", () => {
  const chain = vi.fn(async () => "from chain");

  it("reads the chain when no indexer is configured", async () => {
    const result = await withIndexer({ indexer: null, fromIndexer: async () => "x", fromChain: chain });
    expect(result).toEqual({ source: "chain", data: "from chain" });
  });

  it("reads the indexer when it is ready, with the block it reached", async () => {
    const f = fakeFetch(() =>
      json({ data: { _meta: [{ chainId: 10143, progressBlock: 100, sourceBlock: 120, isReady: true }] } }),
    );
    const indexer = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: f.fetch });
    const result = await withIndexer({ indexer, fromIndexer: async () => "from indexer", fromChain: chain });
    expect(result).toEqual({ source: "indexer", data: "from indexer", indexedBlock: 100n });
  });

  it("falls back to the chain, with a reason, when the indexer fails, lags or rests", async () => {
    const down = fakeFetch(() => new Response("", { status: 503 }));
    const indexer = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: down.fetch });
    const first = await withIndexer({ indexer, fromIndexer: async () => "x", fromChain: chain });
    expect(first.source).toBe("chain");
    expect(first.fallback).toMatch(/did not answer/);
    // Resting: no second request is sent.
    const second = await withIndexer({ indexer, fromIndexer: async () => "x", fromChain: chain });
    expect(second.fallback).toMatch(/failed a moment ago/);
    expect(down.calls).toHaveLength(1);

    const behind = fakeFetch(() =>
      json({ data: { _meta: [{ chainId: 10143, progressBlock: 100, sourceBlock: 5_000, isReady: true }] } }),
    );
    const lagging = makeIndexerClient({ url: URL_, network: "monad-testnet", fetch: behind.fetch });
    const third = await withIndexer({ indexer: lagging, fromIndexer: async () => "x", fromChain: chain });
    expect(third.source).toBe("chain");
    expect(third.fallback).toMatch(/catching up \(block 100 of 5000\)/);
  });

  it("explains each failure in plain words", () => {
    expect(fallbackReason(new IndexerError("timeout", ""))).toMatch(/in time/);
    expect(fallbackReason(new IndexerError("wrong-chain", ""))).toMatch(/another chain/);
    expect(fallbackReason(new Error("boom"))).toMatch(/did not answer/);
  });
});

// ---------- every query against the schema ----------

interface FieldInfo {
  type: string;
  entity: boolean;
}

// Vitest runs from apps/web.
const schemaPath = resolve(process.cwd(), "../../indexer/schema.graphql");
const schema = parse(readFileSync(schemaPath, "utf8"));
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
  const direct = fields?.get(name);
  if (direct) return direct;
  if (name.endsWith("_id") && fields?.get(name.slice(0, -3))?.entity)
    return { type: "String", entity: false };
  return undefined;
}

function checkFilter(entity: string, value: ValueNode, path: string, errors: string[]): void {
  if (value.kind === Kind.LIST) {
    for (const v of value.values) checkFilter(entity, v, path, errors);
    return;
  }
  if (value.kind !== Kind.OBJECT) return;
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

function checkArguments(entity: string, field: FieldNode, path: string, errors: string[]): void {
  for (const arg of field.arguments ?? []) {
    if (arg.name.value === "where" || arg.name.value === "order_by")
      checkFilter(entity, arg.value, path, errors);
  }
}

function checkSelection(entity: string, set: SelectionSetNode, path: string, errors: string[]): void {
  for (const sel of set.selections) {
    if (sel.kind !== Kind.FIELD) continue;
    const name = sel.name.value;
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

describe("the app's indexer queries", () => {
  it.each(Object.entries(ALL_QUERIES))("%s parses and only uses fields the schema has", (_name, query) => {
    expect(validate(parse(query))).toEqual([]);
  });

  it("the checker catches a field the schema does not have", () => {
    const doc = parse("query { Trade(where: { nope: { _eq: 1 } }) { id sizee market { idd } } }");
    expect(validate(doc)).toEqual([
      "Trade: Trade has no field nope",
      "Trade: Trade has no field sizee",
      "Trade.market: Market has no field idd",
    ]);
  });
});
