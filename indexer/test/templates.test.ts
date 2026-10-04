// Templates 3 to 6 through the handlers: a parlay names its legs by market number and takes its deadline
// from theirs, and a touch market proved YES before its window ends counts as an early settlement.
import { describe, expect, it } from "vitest";
import { encodeChainlinkTouchParams, encodeParlayParams } from "../../packages/shared/src/templates.js";
import { ADDR, ALICE, BOB, Outcome, Protocol, priceParams, Side, USDC } from "./helpers.js";

const BTC_FEED = "0x12C0F44368a02081ce58a936d1C1F606BB301715";
const WEEK = 604_800n;
const START = 1_791_039_000n;
const market = (n: number): `0x${string}` =>
  `0x60000000000000000000000000000000000000${n.toString(16).padStart(2, "0")}`;
const yes = (n: number) => `0x61000000000000000000000000000000000000${n.toString(16).padStart(2, "0")}`;
const no = (n: number) => `0x62000000000000000000000000000000000000${n.toString(16).padStart(2, "0")}`;

function addTemplate(p: Protocol, templateId: bigint) {
  p.s.emit(
    "HunchBookFactory",
    "TemplateAdded",
    {
      templateId,
      resolver: `0x00000000000000000000000000000000000000${templateId.toString(16).padStart(2, "0")}`,
      rule: { minPool: USDC(500), minStakers: 10n, minChanceBps: 300n, maxChanceBps: 9_700n },
    },
    ADDR.factory,
  );
}

function create(p: Protocol, n: number, templateId: bigint, params: string, creator = ALICE) {
  p.s.next({ from: creator });
  p.createMarket({ market: market(n), yes: yes(n), no: no(n), creator, templateId, params });
}

describe("templates 3 to 6", () => {
  it("name a parlay's legs by number and take its deadline from theirs", async () => {
    const p = new Protocol();
    p.addTemplates();
    addTemplate(p, 6n);
    const closes = [START + 86_400n, START + 3n * 86_400n];
    closes.forEach((closeTime, i) => {
      create(p, i + 1, 2n, priceParams({ feed: BTC_FEED, strikeE8: 1n, lockTime: START + 600n, closeTime }));
    });
    const parlayClose = START + 2n * 86_400n;
    create(
      p,
      3,
      6n,
      encodeParlayParams({ legs: [market(2), market(1)], lockTime: START + 600n, closeTime: parlayClose }),
    );
    await p.run();
    const parlay = await p.indexer.Market.getOrThrow(market(3));
    expect(parlay).toMatchObject({
      number: 3,
      question: "Will all 2 of these Hunch Book markets settle YES: #1, #2?",
      legs: [market(1), market(2)],
      lockAt: START + 600n,
      closeAt: parlayClose,
      // The later leg's deadline (its close plus 7 days), plus 7 days.
      settleDeadline: (closes[1] as bigint) + WEEK + WEEK,
      blockClock: false,
    });
  });

  it("count a touch proved before the window ends as an early settlement", async () => {
    const p = new Protocol();
    p.addTemplates();
    addTemplate(p, 3n);
    const end = START + 7n * 86_400n;
    create(
      p,
      1,
      3n,
      encodeChainlinkTouchParams({
        feed: BTC_FEED,
        strikeE8: 10_000_000_000_000n,
        direction: 0,
        lockTime: START + 600n,
        startTime: START + 600n,
        endTime: end,
      }),
    );
    p.s.next({ from: BOB });
    p.stake({ market: market(1), user: BOB, side: Side.No, amount: USDC(30) });
    // Two days in, the keeper points at a round that touched the strike.
    p.s.next({ blocks: 400_000, seconds: 2 * 86_400, from: ADDR.keeper });
    p.settlePool({ market: market(1), outcome: Outcome.Yes });
    await p.run();
    expect(await p.indexer.Market.getOrThrow(market(1))).toMatchObject({
      comparator: "AtOrAbove",
      asset: "BTC/USD",
      windowStart: START + 600n,
      closeAt: end,
      settleDeadline: end + 86_400n + WEEK,
      stage: "Settled",
    });
    expect(await p.indexer.Settlement.getOrThrow(market(1))).toMatchObject({
      early: true,
      latencySeconds: undefined,
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      earlySettlements: 1,
      settlementsTimed: 0,
    });
  });
});
