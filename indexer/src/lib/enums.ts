import type { Enum } from "envio";

// Solidity enum ordinals (contracts/src/interfaces/IHunchBookTypes.sol, IHunchRouter.sol) to schema enums.

export function sideOf(ordinal: bigint): Enum<"Side"> {
  if (ordinal === 0n) return "Yes";
  if (ordinal === 1n) return "No";
  throw new Error(`unknown side ${ordinal}`);
}

export function outcomeOf(ordinal: bigint): Enum<"Outcome"> {
  if (ordinal === 1n) return "Yes";
  if (ordinal === 2n) return "No";
  return "Unresolved";
}

const ROUTER_KINDS = [
  "BuyYes",
  "SellYes",
  "BuyNo",
  "SellNo",
] as const satisfies readonly Enum<"RouterTradeKind">[];

export function routerKindOf(ordinal: bigint): Enum<"RouterTradeKind"> {
  const kind = ROUTER_KINDS[Number(ordinal)];
  if (!kind) throw new Error(`unknown router trade kind ${ordinal}`);
  return kind;
}

export function isBuyKind(kind: Enum<"RouterTradeKind">): boolean {
  return kind === "BuyYes" || kind === "BuyNo";
}
