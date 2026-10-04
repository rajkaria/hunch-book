import { decodePerplFundingParams } from "@hunch-book/shared";
import type { Settler } from "./index.js";

// Template 1, Perpl funding (docs/PROTOCOL.md §6.1). The resolver reads Perpl's funding history itself,
// so the evidence is empty. It answers only once block.number > endBlock, when every funding event in
// the window is final. If it still returns Unresolved (Perpl upgraded, perp paused or rescaled), the
// market's `settle` reverts NotResolved: the keeper sees that in the simulation and backs off.

export const perplFundingSettler: Settler = {
  name: "perpl-funding",

  waitReason(market, now) {
    const p = decodePerplFundingParams(market.params);
    return now.block > p.endBlock ? null : `waiting for block > ${p.endBlock}`;
  },

  async evidence(market) {
    const p = decodePerplFundingParams(market.params);
    return {
      status: "ready",
      evidence: "0x",
      value: 0n,
      detail: { perpId: p.perpId, startBlock: p.startBlock, endBlock: p.endBlock, threshold: p.threshold },
    };
  },
};
