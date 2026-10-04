// Fair value for template 6, parlay (docs/TEMPLATES.md): "Will every one of these Hunch Book markets
// settle YES?" NO as soon as one leg settles NO; YES once all settle YES; a leg that voids while none is
// NO voids the parlay, and a voided market's tokens redeem at 0.50.
//
// Model: the product of the legs' chances, which assumes the legs are independent. That is flagged in
// every quote's detail: legs on one asset (BTC above 80,000 and BTC touches 85,000) move together, and
// then the product is wrong. A leg's chance is its book's mid when it has a two-sided book, otherwise
// the maker's own model for its template.

export interface LegValue {
  market: string;
  /** "settled-yes" | "settled-no" | "voided" | "open". */
  state: "settled-yes" | "settled-no" | "voided" | "open";
  /** The leg's chance of YES while open. */
  p?: number;
  /** Where `p` came from: "book" (mid) or "model". */
  source?: "book" | "model";
}

export interface ParlayFair {
  p: number;
  decided: boolean;
  assumption: "legs are independent";
  legs: LegValue[];
}

export function parlayFairValue(legs: LegValue[]): ParlayFair {
  const base = { assumption: "legs are independent" as const, legs };
  if (legs.some((l) => l.state === "settled-no")) return { p: 0, decided: true, ...base };
  if (legs.some((l) => l.state === "voided")) {
    // No leg is NO yet, but one more could still be: that would make the parlay NO (0), otherwise it
    // voids (0.50). The chance no open leg settles NO weighs the two.
    const open = legs.filter((l) => l.state === "open");
    const noneNo = open.reduce((acc, l) => acc * (l.p ?? 0.5), 1);
    return { p: 0.5 * noneNo, decided: open.length === 0, ...base };
  }
  const p = legs.reduce((acc, l) => acc * (l.state === "settled-yes" ? 1 : (l.p ?? Number.NaN)), 1);
  if (!Number.isFinite(p)) throw new Error("a parlay leg has no chance to price it with");
  return { p, decided: legs.every((l) => l.state === "settled-yes"), ...base };
}
