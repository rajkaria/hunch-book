import { impliedChanceBps, Outcome, Phase, poolPayout, Side } from "@hunch-book/shared";
import { maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  bookMid,
  chanceDisplay,
  estimateBlockTime,
  graduationProgress,
  marketChance,
  milestoneText,
  nextMilestone,
  parseBestBidAsk,
  parsePhaseGroup,
  parseUsdcInput,
  phaseGroup,
  phaseLabel,
  phaseTone,
  previewStake,
  priceE18ToBps,
  validateStake,
  voidTerms,
} from "../src/lib/market/logic";
import { clock, makeMarket, USDC } from "./fixtures";

describe("phases", () => {
  it("groups phases for the markets filter", () => {
    expect(phaseGroup(Phase.Pool)).toBe("pools");
    expect(phaseGroup(Phase.Graduated)).toBe("trading");
    expect(phaseGroup(Phase.PoolLocked)).toBe("settling");
    expect(phaseGroup(Phase.Closed)).toBe("settling");
    expect(phaseGroup(Phase.Settled)).toBe("settled");
    expect(phaseGroup(Phase.Voided)).toBe("settled");
  });

  it("parses the filter from the query string", () => {
    expect(parsePhaseGroup("trading")).toBe("trading");
    expect(parsePhaseGroup(["settled", "pools"])).toBe("settled");
    expect(parsePhaseGroup("nonsense")).toBe("all");
    expect(parsePhaseGroup(undefined)).toBe("all");
  });

  it("labels and tones every phase", () => {
    expect(phaseLabel(Phase.Pool)).toBe("Pool");
    expect(phaseLabel(Phase.Graduated)).toBe("Trading");
    expect(phaseLabel(Phase.PoolLocked)).toBe("Pool locked");
    expect(phaseTone(Phase.Pool)).toBe("accent");
    expect(phaseTone(Phase.Closed)).toBe("warn");
    expect(phaseTone(Phase.Voided)).toBe("muted");
    expect(phaseTone(Phase.Settled)).toBe("neutral");
  });
});

describe("Kuru best bid/ask", () => {
  const E18 = 10n ** 18n;

  it("treats an empty bid (uint256 max) and an empty ask (0) as missing", () => {
    expect(parseBestBidAsk(maxUint256, 0n)).toEqual({ bid: null, ask: null });
    expect(parseBestBidAsk(maxUint256, (E18 * 6n) / 10n)).toEqual({ bid: null, ask: (E18 * 6n) / 10n });
    expect(parseBestBidAsk((E18 * 55n) / 100n, 0n)).toEqual({ bid: (E18 * 55n) / 100n, ask: null });
  });

  it("only gives a mid with both sides", () => {
    expect(bookMid({ bid: (E18 * 60n) / 100n, ask: (E18 * 64n) / 100n })).toBe((E18 * 62n) / 100n);
    expect(bookMid({ bid: null, ask: E18 / 2n })).toBeNull();
    expect(bookMid(null)).toBeNull();
  });

  it("converts a 1e18 price to basis points, clamped", () => {
    expect(priceE18ToBps((E18 * 62n) / 100n)).toBe(6_200n);
    expect(priceE18ToBps(E18 * 2n)).toBe(10_000n);
  });
});

describe("marketChance", () => {
  it("uses the pool split before graduation", () => {
    const m = makeMarket({ pool: { yes: USDC(300), no: USDC(100), total: 0n, stakers: 4 } });
    expect(marketChance(m)).toMatchObject({ bps: 7_500n, source: "pool" });
    expect(marketChance(m).bps).toBe(impliedChanceBps(USDC(300), USDC(100)));
  });

  it("says when nobody has staked", () => {
    const m = makeMarket({ pool: { yes: 0n, no: 0n, total: 0n, stakers: 0 } });
    expect(marketChance(m)).toMatchObject({ bps: null, source: "empty" });
  });

  it("uses the Kuru mid once graduated, and says when the book is one-sided", () => {
    const E18 = 10n ** 18n;
    const two = makeMarket({
      phase: Phase.Graduated,
      quote: { bid: (E18 * 40n) / 100n, ask: (E18 * 44n) / 100n },
    });
    expect(marketChance(two)).toMatchObject({ bps: 4_200n, source: "book" });
    const one = makeMarket({ phase: Phase.Graduated, quote: { bid: null, ask: (E18 * 44n) / 100n } });
    expect(marketChance(one)).toMatchObject({ bps: null, source: "book-empty" });
  });

  it("reports settled and voided markets", () => {
    expect(marketChance(makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes }))).toMatchObject({
      bps: 10_000n,
    });
    expect(marketChance(makeMarket({ phase: Phase.Settled, outcome: Outcome.No }))).toMatchObject({
      bps: 0n,
    });
    expect(marketChance(makeMarket({ phase: Phase.Voided }))).toMatchObject({ bps: null, source: "void" });
  });

  it("formats the headline number", () => {
    expect(chanceDisplay({ bps: 10_000n, source: "settled", note: "" })).toEqual({
      value: "YES",
      caption: "won",
    });
    expect(chanceDisplay({ bps: 0n, source: "settled", note: "" })).toEqual({ value: "NO", caption: "won" });
    expect(chanceDisplay({ bps: 6_250n, source: "pool", note: "" })).toEqual({
      value: "62.5%",
      caption: "chance of YES",
    });
    expect(chanceDisplay({ bps: null, source: "empty", note: "No stakes yet" })).toEqual({
      value: "n/a",
      caption: "No stakes yet",
    });
  });
});

describe("time", () => {
  it("estimates block times from the head and the measured pace", () => {
    expect(estimateBlockTime(1_009_000n, clock)).toBe(clock.timestamp + 4_000);
    expect(estimateBlockTime(998_000n, clock)).toBe(clock.timestamp - 400);
  });

  it("counts down to lock in a pool, close when trading, the deadline when settling", () => {
    const now = 1_799_000_000;
    const pool = nextMilestone(makeMarket(), null, now);
    expect(pool).toEqual({ label: "Locks in", moment: { time: 1_800_000_000, estimated: false } });
    const trading = nextMilestone(makeMarket({ phase: Phase.Graduated }), null, now);
    expect(trading?.label).toBe("Closes in");
    const closed = nextMilestone(makeMarket({ phase: Phase.Closed }), null, now);
    expect(closed).toEqual({ label: "Settle within", moment: { time: 1_800_691_200, estimated: false } });
    expect(nextMilestone(makeMarket({ phase: Phase.Settled }), null, now)).toBeNull();
  });

  it("shows a locked pool's close first, then its deadline", () => {
    const m = makeMarket({ phase: Phase.PoolLocked });
    expect(nextMilestone(m, null, 1_800_050_000)?.label).toBe("Closes in");
    expect(nextMilestone(m, null, 1_800_090_000)?.label).toBe("Settle within");
  });

  it("estimates block-clock milestones only once the chain head is known", () => {
    const m = makeMarket({ templateId: 1 });
    expect(nextMilestone(m, null, clock.timestamp)).toBeNull();
    const withClock = nextMilestone(m, clock, clock.timestamp);
    expect(withClock?.moment).toEqual({ block: 1_000_000n, time: clock.timestamp + 400, estimated: true });
  });

  it("words the countdown, and what it means once the time has passed", () => {
    const at = (time: number, estimated = false) => ({ time, estimated });
    expect(milestoneText({ label: "Locks in", moment: at(1_000 + 3_660) }, 1_000)).toBe("Locks in 1h 1m");
    expect(milestoneText({ label: "Closes in", moment: at(1_400, true) }, 1_000)).toBe(
      "Closes in about 6m 40s",
    );
    expect(milestoneText({ label: "Locks in", moment: at(900) }, 1_000)).toBe("Locking now");
    expect(milestoneText({ label: "Closes in", moment: at(1_000) }, 1_000)).toBe("Closing now");
    expect(milestoneText({ label: "Settle within", moment: at(1) }, 1_000)).toBe(
      "Past the settlement deadline",
    );
  });
});

describe("stake input and preview", () => {
  it("parses USDC typed by a person", () => {
    expect(parseUsdcInput("10")).toBe(10_000_000n);
    expect(parseUsdcInput("1,250.5")).toBe(1_250_500_000n);
    expect(parseUsdcInput(" .25 ")).toBe(250_000n);
    expect(parseUsdcInput("0.000001")).toBe(1n);
    expect(parseUsdcInput("0.0000001")).toBeNull();
    expect(parseUsdcInput("0")).toBeNull();
    expect(parseUsdcInput("-5")).toBeNull();
    expect(parseUsdcInput("1e3")).toBeNull();
    expect(parseUsdcInput("")).toBeNull();
    expect(parseUsdcInput(".")).toBeNull();
  });

  it("previews a YES stake with the shared payout math, including the stake itself in the pool", () => {
    const p = previewStake({ side: Side.Yes, amount: USDC(100), yesTotal: USDC(300), noTotal: USDC(600) });
    const expected = poolPayout(USDC(100), USDC(400), USDC(600));
    expect(p.paidIfWin).toBe(expected.paid);
    expect(p.feeIfWin).toBe(expected.fee);
    // 100 on YES into 400 YES / 600 NO: gross 150, 2% fee 3, paid 247.
    expect(p.paidIfWin).toBe(USDC(247));
    expect(p.profitIfWin).toBe(USDC(147));
    expect(p.chanceAfterBps).toBe(4_000n);
  });

  it("previews a NO stake symmetrically", () => {
    const p = previewStake({ side: Side.No, amount: USDC(50), yesTotal: USDC(300), noTotal: USDC(50) });
    expect(p.paidIfWin).toBe(poolPayout(USDC(50), USDC(100), USDC(300)).paid);
    expect(p.chanceAfterBps).toBe(7_500n);
  });

  it("refunds in full when the other side is empty", () => {
    const p = previewStake({ side: Side.Yes, amount: USDC(10), yesTotal: 0n, noTotal: 0n });
    expect(p.paidIfWin).toBe(USDC(10));
    expect(p.profitIfWin).toBe(0n);
  });
});

describe("validateStake", () => {
  const caps = { poolCap: USDC(5_000), walletCap: USDC(1_000), minStake: USDC(1), creatorMinStake: USDC(5) };
  const base = {
    amount: USDC(10),
    phase: Phase.Pool,
    caps,
    poolTotal: USDC(400),
    userStake: { yes: 0n, no: 0n },
    balance: USDC(100),
  } as const;

  it("accepts a stake inside every limit", () => {
    expect(validateStake(base)).toBeNull();
  });

  it("explains each limit in plain words", () => {
    expect(validateStake({ ...base, phase: Phase.Graduated })).toMatch(/closed/);
    expect(validateStake({ ...base, amount: null })).toMatch(/Enter an amount/);
    expect(validateStake({ ...base, amount: 500_000n })).toBe("The minimum stake is 1.00 USDC.");
    expect(validateStake({ ...base, poolTotal: USDC(4_995) })).toBe("The pool has room for 5.00 more USDC.");
    expect(validateStake({ ...base, userStake: { yes: USDC(600), no: USDC(395) } })).toMatch(/5\.00 left/);
    expect(validateStake({ ...base, amount: USDC(200) })).toBe("Your wallet holds 100.00 USDC.");
  });

  it("skips the wallet checks it cannot make yet", () => {
    expect(validateStake({ ...base, userStake: null, balance: null, amount: USDC(2_000) })).toBeNull();
  });
});

describe("graduation progress", () => {
  it("compares the pool with the market's own rule", () => {
    const rows = graduationProgress(
      makeMarket({ pool: { yes: USDC(300), no: USDC(100), total: 0n, stakers: 4 } }),
    );
    expect(rows.map((r) => [r.label, r.met])).toEqual([
      ["Pool size", false],
      ["Stakers", false],
      ["Both sides staked", true],
      ["Chance in range", true],
    ]);
    expect(rows[0]?.current).toBe("400.00 USDC");
    expect(rows[0]?.ratio).toBeCloseTo(0.8);
    expect(rows[1]?.ratio).toBeCloseTo(0.4);
    expect(rows[3]?.target).toBe("3% to 97%");
  });

  it("flags a lopsided or empty pool", () => {
    const lopsided = graduationProgress(
      makeMarket({ pool: { yes: USDC(990), no: USDC(10), total: 0n, stakers: 12 } }),
    );
    expect(lopsided.find((r) => r.label === "Chance in range")?.met).toBe(false);
    const empty = graduationProgress(makeMarket({ pool: { yes: 0n, no: 0n, total: 0n, stakers: 0 } }));
    expect(empty.find((r) => r.label === "Chance in range")?.current).toBe("n/a");
  });
});

describe("void terms", () => {
  it("states the pool refund and the 0.50 rule", () => {
    const pool = voidTerms(makeMarket()).join(" ");
    expect(pool).toMatch(/refunds every stake in full/);
    expect(pool).toMatch(/Sat 23 Jan 2027/);
    const graduated = voidTerms(makeMarket({ graduated: true })).join(" ");
    expect(graduated).toMatch(/0\.50 USDC/);
    expect(graduated).toMatch(/not a refund/);
  });

  it("never uses em dashes", () => {
    for (const line of [...voidTerms(makeMarket()), ...voidTerms(makeMarket({ graduated: true }))]) {
      expect(line.includes(String.fromCharCode(0x2014))).toBe(false);
    }
  });
});
