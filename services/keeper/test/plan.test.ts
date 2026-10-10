import {
  encodeChainlinkTouchParams,
  encodePerplFundingParams,
  encodePriceAtTimeParams,
  Phase,
  PriceSource,
  TemplateId,
  TouchDirection,
  type Window,
} from "@hunch-book/shared";
import { type Address, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { Globals } from "../src/markets.js";
import {
  closeReached,
  type Decision,
  needsBookLookup,
  type PlanInput,
  type PlanMarket,
  planMarket,
  ruleShortfall,
} from "../src/plan.js";
import { defaultSettlers } from "../src/settlers/index.js";

const USDC = 1_000_000n;
const settlers = defaultSettlers();
const GRADUATOR = "0x7DC80DB34762A996aae6Ce516F562B2e6142fFE3" as Address;
const BOOK = "0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a" as Address;
const DEADLINE = 1_792_049_704n;
const MARKET = "0x2A44B99014cF73065BFb89197a08DE09D18d3982" as Address;
const RESOLVER = "0x4ec0077e30EA8B626C5AA087C586E60542150951" as Address;

// Market #1 on Monad testnet: Perpl MON funding, lock at block 68,058,301, close at block 68,264,005.
const perplWindow: Window = {
  blockClock: true,
  lock: 68_058_301n,
  close: 68_264_005n,
  settleDeadline: DEADLINE,
};
const perplParams = encodePerplFundingParams({
  perpId: 64n,
  startBlock: perplWindow.lock,
  endBlock: perplWindow.close,
  threshold: 1_500n,
  expectedScalingExp: 6,
});

const testnetGlobals: Globals = {
  graduationPaused: false,
  graduator: GRADUATOR,
  canCreateBooks: true,
  usdc: "0x13c5B2e982F437566991c4d9aC0a30F9f9aC15Ed",
  kuruVersion: 1,
};
const mainnetGlobals: Globals = { ...testnetGlobals, canCreateBooks: false };

function market(over: Partial<PlanMarket> = {}): PlanMarket {
  return {
    address: MARKET,
    resolver: RESOLVER,
    templateId: TemplateId.PerplFunding,
    params: perplParams,
    window: perplWindow,
    rule: { minPool: 500n * USDC, minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 },
    phase: Phase.Pool,
    graduated: false,
    yesTotal: 410n * USDC,
    noTotal: 280n * USDC,
    stakers: 11,
    ruleMet: true,
    graduatorBook: zeroAddress,
    heldYes: 0n,
    heldNo: 0n,
    poolOwed: 690n * USDC,
    ...over,
  };
}

const at = (block: bigint, timestamp = 1_791_000_000n) => ({ block, timestamp });

function plan(m: PlanMarket, now = at(68_000_000n), extra: Partial<PlanInput> = {}): Decision[] {
  return planMarket({
    market: m,
    now,
    globals: testnetGlobals,
    settler: settlers.get(m.templateId),
    ...extra,
  });
}

const byJob = (decisions: Decision[]) => Object.fromEntries(decisions.map((d) => [d.job, d]));

describe("graduate", () => {
  it("graduates a pool that meets its rule when the graduator can create the book", () => {
    expect(plan(market())).toEqual([
      {
        job: "graduate",
        action: "graduate",
        reason: "rule met; the graduator creates the Kuru book in the same transaction",
      },
    ]);
  });

  it("graduates into a book that is already registered", () => {
    const [d] = plan(market({ graduatorBook: BOOK }), at(68_000_000n), { globals: mainnetGlobals });
    expect(d).toMatchObject({ action: "graduate", reason: `rule met and Kuru book ${BOOK} is ready` });
  });

  it("explains which part of the rule is missing", () => {
    const [d] = plan(market({ ruleMet: false, yesTotal: 100n * USDC, noTotal: 20n * USDC, stakers: 4 }));
    expect(d).toEqual({ job: "graduate", reason: "rule not met: pool 120 of 500 USDC; 4 of 10 stakers" });
  });

  it("waits while graduation is paused or no graduator is set", () => {
    expect(plan(market(), at(1n), { globals: { ...testnetGlobals, graduationPaused: true } })[0]).toEqual({
      job: "graduate",
      reason: "rule met, but graduation is paused",
    });
    expect(
      plan(market(), at(1n), { globals: { ...testnetGlobals, graduator: zeroAddress } })[0]?.action,
    ).toBe(undefined);
  });

  it("on mainnet asks Kuru for the book, then registers it once Kuru has deployed it", () => {
    const m = market();
    expect(needsBookLookup(m, mainnetGlobals)).toBe(true);
    expect(needsBookLookup(m, testnetGlobals)).toBe(false);
    expect(needsBookLookup({ ...m, graduatorBook: BOOK }, mainnetGlobals)).toBe(false);
    expect(needsBookLookup({ ...m, ruleMet: false }, mainnetGlobals)).toBe(false);

    const notYet = plan(m, at(1n), {
      globals: mainnetGlobals,
      predictedBook: { address: BOOK, deployed: false },
    });
    expect(notYet[0]?.action).toBe("book-request");
    const deployed = plan(m, at(1n), {
      globals: mainnetGlobals,
      predictedBook: { address: BOOK, deployed: true },
    });
    expect(deployed[0]).toMatchObject({ action: "register-book" });
    expect(deployed[0]?.reason).toContain(BOOK);
  });

  it("Kuru v2: looks for the book from creation, asks for it, registers it before the pool fills", () => {
    const v2: Globals = { ...mainnetGlobals, kuruVersion: 2 };
    const filling = market({ ruleMet: false, yesTotal: 10n * USDC, noTotal: 0n, stakers: 1 });
    // From creation, whatever the rule: Kuru's setup takes days.
    expect(needsBookLookup(filling, v2)).toBe(true);
    expect(needsBookLookup({ ...filling, graduatorBook: BOOK }, v2)).toBe(false);
    expect(needsBookLookup({ ...filling, phase: Phase.PoolLocked }, v2)).toBe(false);
    expect(needsBookLookup(filling, mainnetGlobals)).toBe(false);

    expect(
      plan(filling, at(1n), { globals: v2, predictedBook: { address: BOOK, deployed: false } })[0],
    ).toEqual({
      job: "graduate",
      action: "book-request",
      reason: "only Kuru can create v2 books: ask Kuru for this market's book and token setup",
    });
    const blocked = plan(filling, at(1n), {
      globals: v2,
      predictedBook: {
        address: BOOK,
        deployed: true,
        problem: { code: 10, text: "Kuru has not enabled the YES token or USDC" },
      },
    })[0];
    expect(blocked).toMatchObject({ action: "book-request" });
    expect(blocked?.reason).toContain("Kuru has not enabled the YES token or USDC");
    const ready = plan(filling, at(1n), {
      globals: v2,
      predictedBook: { address: BOOK, deployed: true, problem: { code: 0, text: "none" } },
    })[0];
    expect(ready).toMatchObject({ action: "register-book" });

    // Registered: graduate once the rule is met (and not while graduation is paused).
    expect(plan({ ...filling, graduatorBook: BOOK }, at(1n), { globals: v2 })[0]).toMatchObject({
      job: "graduate",
      reason: expect.stringContaining("rule not met"),
    });
    expect(plan(market({ graduatorBook: BOOK }), at(1n), { globals: v2 })[0]).toMatchObject({
      action: "graduate",
    });
    expect(
      plan(market({ graduatorBook: BOOK }), at(1n), { globals: { ...v2, graduationPaused: true } })[0]
        ?.action,
    ).toBe(undefined);
    expect(plan(filling, at(1n), { globals: { ...v2, graduator: zeroAddress } })[0]).toEqual({
      job: "graduate",
      reason: "the factory has no graduator yet (WireKuruV2.s.sol)",
    });
  });

  it("Hunch order book: graduates in one transaction and never asks Kuru for a book", () => {
    const hunch: Globals = { ...testnetGlobals, venue: "hunch" };
    expect(plan(market(), at(1n), { globals: hunch })).toEqual([
      {
        job: "graduate",
        action: "graduate",
        reason: "rule met; the graduator creates the Hunch order book in the same transaction",
      },
    ]);
    expect(needsBookLookup(market(), hunch)).toBe(false);
    expect(plan(market({ graduatorBook: BOOK }), at(1n), { globals: hunch })[0]?.reason).toBe(
      `rule met and Hunch order book ${BOOK} is ready`,
    );

    // A Hunch graduator that cannot create books is a wiring mistake: wait and say so, even with a
    // predicted book in hand. No book-request and no registerBook, ever.
    const miswired: Globals = { ...hunch, canCreateBooks: false };
    expect(needsBookLookup(market(), miswired)).toBe(false);
    for (const predictedBook of [undefined, { address: BOOK, deployed: true }]) {
      const [d] = plan(market(), at(1n), { globals: miswired, predictedBook });
      expect(d?.action).toBe(undefined);
      expect(d?.reason).toContain("cannot create books");
    }
  });

  it("does nothing for graduation outside the Pool phase", () => {
    const decisions = plan(market({ phase: Phase.PoolLocked }), at(68_100_000n));
    expect(decisions.map((d) => d.job)).toEqual(["settle"]);
  });
});

describe("token claims", () => {
  it("pushes claims while the market still holds tokens, in any phase after graduation", () => {
    for (const phase of [Phase.Graduated, Phase.Closed, Phase.Settled, Phase.Voided]) {
      const m = market({ phase, graduated: true, heldYes: 5n * USDC, heldNo: 1_500_000n, poolOwed: 0n });
      expect(byJob(plan(m, at(68_300_000n))).claims).toEqual({
        job: "claims",
        action: "claim-tokens",
        reason: "the market still holds 5 YES and 1.5 NO for stakers",
      });
    }
  });

  it("is done once the market holds no tokens", () => {
    const m = market({ phase: Phase.Graduated, graduated: true, poolOwed: 0n });
    expect(byJob(plan(m)).claims).toEqual({ job: "claims", reason: "every staker has their tokens" });
  });
});

describe("settle", () => {
  it("market #1 on testnet: waits for the block after endBlock", () => {
    const m = market({ phase: Phase.Graduated, graduated: true, poolOwed: 0n });
    expect(plan(m, at(68_012_925n))).toEqual([
      { job: "claims", reason: "every staker has their tokens" },
      { job: "settle", reason: "waiting for block > 68264005" },
    ]);
    // At endBlock itself the market is Closed, but Perpl's last event may still change: wait one more.
    expect(byJob(plan({ ...m, phase: Phase.Closed }, at(68_264_005n))).settle).toEqual({
      job: "settle",
      reason: "waiting for block > 68264005",
    });
    expect(byJob(plan({ ...m, phase: Phase.Closed }, at(68_264_006n))).settle).toEqual({
      job: "settle",
      action: "settle",
      reason: "close passed: settle the market",
    });
  });

  it("settles a pool that never graduated", () => {
    const decisions = plan(market({ phase: Phase.PoolLocked, ruleMet: false }), at(68_264_006n));
    expect(decisions).toEqual([{ job: "settle", action: "settle", reason: "close passed: settle the pool" }]);
  });

  it("price markets wait for time > T", () => {
    const closeTime = 1_791_100_000n;
    const m = market({
      templateId: TemplateId.PriceAtTime,
      params: encodePriceAtTimeParams({
        source: PriceSource.Chainlink,
        feed: "0x12C0F44368a02081ce58a936d1C1F606BB301715",
        pythId: `0x${"00".repeat(32)}`,
        strikeE8: 100_000n * 10n ** 8n,
        lockTime: closeTime - 3_600n,
        closeTime,
      }),
      window: {
        blockClock: false,
        lock: closeTime - 3_600n,
        close: closeTime,
        settleDeadline: closeTime + 604_800n,
      },
      phase: Phase.Closed,
      graduated: true,
      poolOwed: 0n,
    });
    expect(byJob(plan(m, at(1n, closeTime))).settle).toEqual({
      job: "settle",
      reason: "waiting for time > 1791100000 (2026-10-04T07:46:40.000Z)",
    });
    expect(byJob(plan(m, at(1n, closeTime + 1n))).settle?.action).toBe("settle");
  });

  it("skips templates with no settler", () => {
    const m = market({ templateId: 9, phase: Phase.Closed, graduated: true, poolOwed: 0n });
    expect(byJob(plan(m, at(68_300_000n), { settler: undefined })).settle).toEqual({
      job: "settle",
      reason: "no settler for template 9: skipped",
    });
  });
});

describe("prove (touch templates)", () => {
  const T1 = 1_791_200_000n;
  const T2 = T1 + 7n * 86_400n;
  const touchParams = encodeChainlinkTouchParams({
    feed: "0x12C0F44368a02081ce58a936d1C1F606BB301715",
    strikeE8: 70_000n * 10n ** 8n,
    direction: TouchDirection.AtOrAbove,
    lockTime: T1 - 3_600n,
    startTime: T1,
    endTime: T2,
  });
  const touch = (over: Partial<PlanMarket> = {}) =>
    market({
      templateId: TemplateId.ChainlinkTouch,
      params: touchParams,
      window: { blockClock: false, lock: T1 - 3_600n, close: T2, settleDeadline: T2 + 8n * 86_400n },
      ...over,
    });

  it("hunts for a proof once the market is past staking and the window is open", () => {
    expect(byJob(plan(touch({ phase: Phase.PoolLocked }), at(1n, T1 - 1n))).prove).toEqual({
      job: "prove",
      reason: "waiting for the window to open at 1791200000 (2026-10-05T11:33:20.000Z)",
    });
    const open = plan(touch({ phase: Phase.Graduated, graduated: true, poolOwed: 0n }), at(1n, T1 + 60n));
    expect(byJob(open).prove).toEqual({
      job: "prove",
      action: "prove",
      reason: "look for the observation that proves YES",
    });
    // A pool still taking stakes cannot be proved (the market refuses proveYes in the Pool phase).
    expect(byJob(plan(touch({ phase: Phase.Pool }), at(1n, T1 - 7_200n))).prove).toBeUndefined();
  });

  it("keeps hunting after close, and settles NO only after the challenge period", () => {
    const closed = touch({ phase: Phase.Closed, graduated: true, poolOwed: 0n });
    const before = byJob(plan(closed, at(1n, T2 + 86_399n)));
    expect(before.prove?.action).toBe("prove");
    expect(before.settle?.reason).toMatch(/^waiting for the challenge period to end at/);
    expect(byJob(plan(closed, at(1n, T2 + 86_400n))).settle?.action).toBe("settle");
  });

  it("templates with no early YES have no prove job", () => {
    const m = market({ phase: Phase.Graduated, graduated: true, poolOwed: 0n });
    expect(byJob(plan(m, at(68_100_000n))).prove).toBeUndefined();
  });
});

describe("void", () => {
  it("voids any unsettled market after its settlement deadline, instead of settling", () => {
    for (const phase of [Phase.PoolLocked, Phase.Graduated, Phase.Closed]) {
      const decisions = plan(
        market({ phase, graduated: phase !== Phase.PoolLocked }),
        at(68_300_000n, DEADLINE + 1n),
      );
      expect(byJob(decisions).void).toEqual({
        job: "void",
        action: "void",
        reason: `past the settlement deadline (${DEADLINE}) with no answer`,
      });
      expect(byJob(decisions).settle).toBeUndefined();
    }
  });

  it("settles right up to the deadline", () => {
    const decisions = plan(market({ phase: Phase.Closed, graduated: true }), at(68_300_000n, DEADLINE));
    expect(byJob(decisions).settle?.action).toBe("settle");
    expect(byJob(decisions).void).toBeUndefined();
  });

  it("never voids a settled or voided market", () => {
    for (const phase of [Phase.Settled, Phase.Voided]) {
      expect(byJob(plan(market({ phase }), at(68_300_000n, DEADLINE + 100n))).void).toBeUndefined();
    }
  });
});

describe("pool payouts", () => {
  it("pushes payouts for a pool-only market after settlement or void", () => {
    for (const phase of [Phase.Settled, Phase.Voided]) {
      expect(plan(market({ phase, poolOwed: 8_500_000n }), at(68_300_000n))).toEqual([
        { job: "payouts", action: "claim-pool", reason: "8.5 USDC of pool payouts not yet claimed" },
      ]);
    }
  });

  it("is done once the pool ledger is empty", () => {
    expect(plan(market({ phase: Phase.Settled, poolOwed: 0n }), at(68_300_000n))).toEqual([
      { job: "payouts", reason: "every pool payout is done" },
    ]);
  });

  it("never pays a pool for a graduated market (tokens carry its value)", () => {
    const decisions = plan(market({ phase: Phase.Settled, graduated: true, poolOwed: 5n }), at(68_300_000n));
    expect(byJob(decisions).payouts).toBeUndefined();
  });
});

describe("helpers", () => {
  it("closeReached follows the market's clock", () => {
    expect(closeReached(perplWindow, at(68_264_004n))).toBe(false);
    expect(closeReached(perplWindow, at(68_264_005n))).toBe(true);
    const timeWindow: Window = { blockClock: false, lock: 10n, close: 20n, settleDeadline: 30n };
    expect(closeReached(timeWindow, at(999_999_999n, 19n))).toBe(false);
    expect(closeReached(timeWindow, at(0n, 20n))).toBe(true);
  });

  it("ruleShortfall names each unmet part", () => {
    const rule = { minPool: 500n * USDC, minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 };
    expect(ruleShortfall({ yesTotal: 600n * USDC, noTotal: 0n, stakers: 12, rule })).toEqual([
      "one side has no stake",
    ]);
    expect(ruleShortfall({ yesTotal: 990n * USDC, noTotal: 10n * USDC, stakers: 12, rule })).toEqual([
      "chance 99% is outside 3% to 97%",
    ]);
    expect(ruleShortfall({ yesTotal: 300n * USDC, noTotal: 300n * USDC, stakers: 12, rule })).toEqual([]);
  });
});
