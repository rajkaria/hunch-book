import type { Hex } from "viem";

// Links into the create flow, prefilled. /create reads `template` (the template id); `params` carries the
// exact ABI-encoded parameters the shortcut proposes, which decode with the shared template decoders
// (packages/shared/src/templates.ts), so the create form can fill every field from them. `from` says which
// page sent the visitor.

export type PrefillSource = "ladder" | "parlay";

export function createPrefillPath(templateId: number, params: Hex, from: PrefillSource): string {
  const q = new URLSearchParams({ template: String(templateId), params, from });
  return `/create?${q.toString()}`;
}

/** Reads a prefill back: the template id and params, or null when either is missing or malformed. */
export function parsePrefill(search: URLSearchParams): { templateId: number; params: Hex } | null {
  const template = Number(search.get("template"));
  const params = search.get("params");
  if (!Number.isInteger(template) || template <= 0) return null;
  if (!params || !/^0x(?:[0-9a-fA-F]{2})*$/.test(params)) return null;
  return { templateId: template, params: params as Hex };
}
