import { deployments, encodePerplFundingSpikeParams, TemplateId } from "@hunch-book/shared";
import { describe, expect, it } from "vitest";
import { formatInt, formatShortUtc } from "../src/lib/format";
import { decodeMarketParams } from "../src/lib/market/params";
import {
  blockWindowWords,
  friendlyQuestion,
  marketTitle,
  roundedBlockTime,
  type TitleClock,
  titleDiffersFromRule,
} from "../src/lib/market/title";
import { makeMarket } from "./fixtures";

// Market titles: Perpl's resolver sentences name block numbers; titles read them as estimated times.

const testnet = deployments["monad-testnet"];

// Head block 68,036,598 at 2026-10-04 01:00:00 UTC, 400 ms per block.
const HEAD_TIME = Date.UTC(2026, 9, 4, 1, 0, 0) / 1000;
const clock: TitleClock = { blockNumber: 68_036_598n, timestamp: HEAD_TIME, msPerBlock: 400 };
/** The block expected `seconds` after the head. */
const blockIn = (seconds: number): bigint => clock.blockNumber + BigInt((seconds * 1000) / 400);

// Market #1 on testnet, as its resolver describes it.
const START = blockIn(5 * 3_600 + 10 * 60); // about 06:10
const END = blockIn(24 * 3_600); // about 01:00 the next day
const RULE_1 = `Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block ${START} and block ${END}?`;

describe("formatShortUtc", () => {
  it("writes a short UTC month, day and time", () => {
    expect(formatShortUtc(HEAD_TIME)).toBe("Oct 4, 01:00");
    expect(formatShortUtc(Date.UTC(2027, 0, 16, 8, 5) / 1000)).toBe("Jan 16, 08:05");
    expect(formatShortUtc(Number.NaN)).toBe("unknown time");
  });
});

describe("block times in titles", () => {
  it("estimates a block's time from the head and the pace, rounded to five minutes", () => {
    expect(roundedBlockTime(START, clock)).toBe(HEAD_TIME + 5 * 3_600 + 10 * 60);
    // Two minutes past a five-minute mark rounds down; three minutes past rounds up.
    expect(roundedBlockTime(blockIn(120), clock)).toBe(HEAD_TIME);
    expect(roundedBlockTime(blockIn(180), clock)).toBe(HEAD_TIME + 300);
    // A block in the past works the same way.
    expect(roundedBlockTime(clock.blockNumber - 9_000n, clock)).toBe(HEAD_TIME - 3_600);
  });

  it("names the window with times, or the grouped blocks while there is no clock", () => {
    expect(blockWindowWords(START, END, clock)).toBe("between about Oct 4, 06:10 and Oct 5, 01:00 UTC");
    expect(blockWindowWords(68_058_301n, 68_264_005n, null)).toBe(
      "between block 68,058,301 and block 68,264,005",
    );
    expect(blockWindowWords(1n, 2n, { ...clock, msPerBlock: 0 })).toBe("between block 1 and block 2");
  });
});

describe("friendlyQuestion", () => {
  it("turns template 1's sentence into times and drops the venue detail", () => {
    expect(friendlyQuestion(RULE_1, clock)).toBe(
      "Will MON longs pay more than $0.000015 per MON in funding on Perpl between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    expect(friendlyQuestion(RULE_1, null)).toBe(
      `Will MON longs pay more than $0.000015 per MON in funding on Perpl between block ${formatInt(START)} and block ${formatInt(END)}?`,
    );
  });

  it("handles the net-funding shape and the resolver's text when Perpl did not answer", () => {
    expect(
      friendlyQuestion(
        `Will BTC longs pay shorts on net in funding on Perpl (BTC Perp, perp 16) between block ${START} and block ${END}?`,
        clock,
      ),
    ).toBe(
      "Will BTC longs pay shorts on net in funding on Perpl between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    expect(
      friendlyQuestion(
        `Will longs on Perpl perp 64 pay more than 15 raw funding units between block ${START} and block ${END}?`,
        clock,
      ),
    ).toBe(
      "Will longs on Perpl perp 64 pay more than 15 raw funding units between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
  });

  it("asks template 4's rule as a question", () => {
    const spike = `YES if any single funding event on Perpl (BTC Perp, perp 16) after block ${START} and at or before block ${END} charges BTC longs more than $2.5 per BTC; NO if nobody proves one by block ${END + 216_000n}, about 24 hours after the window.`;
    expect(friendlyQuestion(spike, clock)).toBe(
      "Will any single BTC funding event on Perpl charge longs more than $2.5 per BTC between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    const raw = `YES if any single funding event on Perpl perp 16 after block ${START} and at or before block ${END} charges longs more than 25 raw funding units; NO if nobody proves one by block 1, about 24 hours after the window.`;
    expect(friendlyQuestion(raw, clock)).toBe(
      "Will any single funding event on Perpl charge longs more than 25 raw funding units between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
  });

  it("leaves text without a block window as it is", () => {
    const price = "Will BTC/USD be at or above $120,000 at 2027-01-16 08:00:00 UTC?";
    expect(friendlyQuestion(price, clock)).toBe(price);
  });
});

// Template 7 and template 6 sentences, word for word as SnapshotResolver and MarketOutcomeResolver
// return them on testnet.
const SNAPSHOT_RULE =
  "YES if Perpl's MON mark price (perp 64) is at or above $0.025 in the first snapshot taken from 2026-10-12 16:00:00 UTC to 2026-10-12 16:30:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids.";
const OI_RULE =
  "YES if Perpl's BTC open interest (perp 16) is below 22.00000 BTC in the first snapshot taken from 2026-10-15 18:00:00 UTC to 2026-10-15 18:30:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids.";
const PARLAY_RULE =
  "YES if all 2 of these Hunch Book markets settle YES: #5 (0x6ac842C5240eAC9207e0C66e7AA99448887Abdb1), #6 (0xb9cA87cb725aa34444d3Be1906D5472C63bB00A9); NO if any of them settles NO; if one voids while none has settled NO, this market voids at its deadline.";

describe("friendlyQuestion for snapshot and parlay rules", () => {
  it("asks a snapshot rule at the time its window opens, without the perp detail", () => {
    expect(friendlyQuestion(SNAPSHOT_RULE, null)).toBe(
      "Will Perpl's MON mark price be at or above $0.025 at Oct 12, 16:00 UTC?",
    );
    expect(friendlyQuestion(OI_RULE, clock)).toBe(
      "Will Perpl's BTC open interest be below 22.00000 BTC at Oct 15, 18:00 UTC?",
    );
  });

  it("asks a parlay rule by its legs' market numbers", () => {
    expect(friendlyQuestion(PARLAY_RULE, null)).toBe("Will markets #5 and #6 both settle YES?");
    const three = PARLAY_RULE.replace("all 2", "all 3").replace(
      "; NO if",
      ", 0x37A0dFD460d61E1e60D5AD8770B71C0B47F1920E; NO if",
    );
    expect(friendlyQuestion(three, null)).toBe("Will markets #5, #6 and 0x37A0...920E all settle YES?");
  });

  it("is used as the title of snapshot and parlay markets, and the page then shows the rule too", () => {
    const snap = makeMarket({ templateId: TemplateId.Snapshot, description: SNAPSHOT_RULE });
    const title = marketTitle(snap, testnet, null);
    expect(title).toBe("Will Perpl's MON mark price be at or above $0.025 at Oct 12, 16:00 UTC?");
    expect(titleDiffersFromRule(snap, title)).toBe(true);
    const parlay = makeMarket({ templateId: TemplateId.Parlay, description: PARLAY_RULE });
    expect(marketTitle(parlay, testnet, null)).toBe("Will markets #5 and #6 both settle YES?");
  });
});

describe("marketTitle", () => {
  it("uses the resolver's sentence for Perpl markets, with times", () => {
    const m = makeMarket({ templateId: TemplateId.PerplFunding, description: RULE_1 });
    expect(marketTitle(m, testnet, clock)).toBe(
      "Will MON longs pay more than $0.000015 per MON in funding on Perpl between about Oct 4, 06:10 and Oct 5, 01:00 UTC?",
    );
    expect(titleDiffersFromRule(m, marketTitle(m, testnet, clock))).toBe(true);
  });

  it("builds a Perpl title from the params when the resolver did not answer", () => {
    // The fixture's window is blocks 1,000,000 to 1,002,000 with threshold 0, on testnet's BTC perp.
    const m = makeMarket({ templateId: TemplateId.PerplFunding, description: null });
    expect(marketTitle(m, testnet, null)).toBe(
      "Will BTC longs pay shorts on net on Perpl between block 1,000,000 and block 1,002,000?",
    );
    const old = { blockNumber: 1_001_000n, timestamp: HEAD_TIME, msPerBlock: 400 };
    expect(marketTitle(m, testnet, old)).toBe(
      "Will BTC longs pay shorts on net on Perpl between about Oct 4, 00:55 and Oct 4, 01:05 UTC?",
    );
    expect(titleDiffersFromRule(m, marketTitle(m, testnet, old))).toBe(false);
  });

  it("builds a spike title from the params when the resolver did not answer", () => {
    const params = encodePerplFundingSpikeParams({
      perpId: 16n,
      startBlock: 1_000_000n,
      endBlock: 1_002_000n,
      threshold: 25n,
      expectedScalingExp: 0,
    });
    const m = makeMarket({
      templateId: TemplateId.PerplFundingSpike,
      params,
      decoded: decodeMarketParams(TemplateId.PerplFundingSpike, params),
      description: null,
    });
    expect(marketTitle(m, testnet, null)).toBe(
      "Will any single BTC funding event on Perpl charge longs more than 25 (raw Perpl units) between block 1,000,000 and block 1,002,000?",
    );
  });

  it("keeps every other template's sentence, and falls back to one from the params", () => {
    const price = makeMarket();
    expect(marketTitle(price, testnet, clock)).toBe(price.description);
    expect(titleDiffersFromRule(price, marketTitle(price, testnet, clock))).toBe(false);
    expect(marketTitle(makeMarket({ description: null }), deployments["monad-mainnet"], clock)).toBe(
      "Will BTC/USD be at or above $120,000.00 at Sat 16 Jan 2027, 08:00 UTC?",
    );
  });

  it("never throws on bad params", () => {
    const m = makeMarket({ templateId: TemplateId.PerplFunding, params: "0x1234", description: null });
    expect(marketTitle(m, testnet, clock)).toBe("Market with an unknown template");
  });
});
