import { decodePriceRangeParams } from "@hunch-book/shared";
import type { Settler } from "./index.js";
import { priceEvidence, waitForTime } from "./priceAtTime.js";

// Template 5, price range (docs/TEMPLATES.md). The resolver reads the price at T exactly like template 2
// (the same bracketing Chainlink round, or the same first Pyth update at or after T) and answers YES if
// lower <= price < upper. So the evidence is template 2's, built by the same code.

export const priceRangeSettler: Settler = {
  name: "price-range",

  waitReason(market, now) {
    return waitForTime(decodePriceRangeParams(market.params).closeTime, now);
  },

  async evidence(market, _now, deps) {
    const p = decodePriceRangeParams(market.params);
    const result = await priceEvidence(p, market, deps);
    if (result.status !== "ready") return result;
    return { ...result, detail: { ...result.detail, lowerE8: p.lowerE8, upperE8: p.upperE8 } };
  },
};
