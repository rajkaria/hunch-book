import {
  encodePriceAtTimeParams,
  Outcome,
  Phase,
  PriceSource,
  redemptionPayout,
  Side,
  TemplateId,
} from "@hunch-book/shared";
import { describe, expect, it } from "vitest";
import {
  type ChainHead,
  closeReached,
  feePerToken,
  type Holdings,
  type LifecycleAction,
  lifecycleActions,
  pastDeadline,
  redeemSteps,
  setsAvailability,
  settleGate,
} from "../src/lib/market/actions";
import { decodeMarketParams } from "../src/lib/market/params";
import { entryPlan, entryValueAtMid, portfolioPlan, portfolioTotals } from "../src/lib/market/portfolio";
import type { MarketView } from "../src/lib/market/types";
import { makeEntry, makeMarket, USDC } from "./fixtures";

// Every lifecycle call is enabled only in the phase and at the time the contracts accept it
// (Market.sol, CollateralVault.sol). Price markets close at unix 1_800_086_400 with a deadline seven
// days later; Perpl markets close at block 1_002_000.

const CLOSE = 1_800_086_400;
const DEADLINE = 1_800_691_200;
const before: ChainHead = { block: 999_000n, time: CLOSE - 60 };
const afterClose: ChainHead = { block: 1_002_001n, time: CLOSE + 60 };
const afterDeadline: ChainHead = { block: 3_000_000n, time: DEADLINE + 1 };

const holdings = (overrides: Partial<Holdings> = {}): Holdings => ({
  claimableTokens: { yes: 0n, no: 0n },
  claimablePool: { paid: 0n, fee: 0n },
  balances: { yes: 0n, no: 0n },
  ...overrides,
});

const byId = (list: LifecycleAction[]) => Object.fromEntries(list.map((a) => [a.id, a]));

const graduated = (overrides: Partial<MarketView> = {}) =>
  makeMarket({
    phase: Phase.Graduated,
    graduated: true,
    pool: { yes: USDC(410), no: USDC(280), total: USDC(690), stakers: 11 },
    ...overrides,
  });

describe("time gates", () => {
  it("reads close by block for Perpl markets and by time for price markets", () => {
    const perpl = makeMarket({ templateId: TemplateId.PerplFunding });
    expect(closeReached(perpl, { block: 1_001_999n, time: 0 })).toBe(false);
    expect(closeReached(perpl, { block: 1_002_000n, time: 0 })).toBe(true);
    const price = makeMarket();
    expect(closeReached(price, { block: 0n, time: CLOSE - 1 })).toBe(false);
    expect(closeReached(price, { block: 0n, time: CLOSE })).toBe(true);
    expect(closeReached(price, null)).toBe(false);
    expect(pastDeadline(price, { block: 0n, time: DEADLINE })).toBe(false);
    expect(pastDeadline(price, { block: 0n, time: DEADLINE + 1 })).toBe(true);
  });
});

describe("settleGate", () => {
  const closed = graduated({ phase: Phase.Closed });

  it("opens after close and closes after the deadline", () => {
    expect(settleGate(closed, null)).toMatch(/Reading the chain/);
    expect(settleGate(closed, before)).toMatch(/Settlement opens at close: .*2027/);
    expect(settleGate(closed, afterClose)).toBeNull();
    expect(settleGate(closed, afterDeadline)).toMatch(/deadline has passed/);
    expect(settleGate(makeMarket({ templateId: TemplateId.PerplFunding }), before)).toMatch(
      /opens at close: block 1,002,000/,
    );
  });

  it("refuses final markets and sends Pyth markets to the keeper", () => {
    expect(settleGate(graduated({ phase: Phase.Settled }), afterClose)).toBe("Already settled.");
    expect(settleGate(graduated({ phase: Phase.Voided }), afterDeadline)).toMatch(/voided/);
    const pythParams = encodePriceAtTimeParams({
      source: PriceSource.Pyth,
      feed: "0x0000000000000000000000000000000000000000",
      pythId: `0x${"11".repeat(32)}`,
      strikeE8: 1n,
      lockTime: 1n,
      closeTime: BigInt(CLOSE),
    });
    const pyth = graduated({
      phase: Phase.Closed,
      params: pythParams,
      decoded: decodeMarketParams(TemplateId.PriceAtTime, pythParams),
    });
    expect(settleGate(pyth, afterClose)).toMatch(/Pyth API key\. The keeper settles these/);
  });
});

describe("lifecycleActions per phase", () => {
  it("pool: graduate only when the rule is met; settle and void wait", () => {
    const pool = makeMarket({ phase: Phase.Pool });
    const a = byId(lifecycleActions(pool, before, holdings()));
    expect(Object.keys(a)).toEqual(["graduate", "settle", "void"]);
    expect(a.graduate?.enabled).toBe(false);
    expect(a.graduate?.reason).toMatch(/does not meet/);
    expect(byId(lifecycleActions(makeMarket({ ruleMet: true }), before, null)).graduate?.enabled).toBe(true);
    expect(a.settle?.enabled).toBe(false);
    expect(a.void?.enabled).toBe(false);
    expect(a.void?.reason).toMatch(/Only if nobody settles by the deadline/);
  });

  it("pool locked: settle after close, pool payout after settlement", () => {
    const locked = makeMarket({ phase: Phase.PoolLocked });
    const a = byId(lifecycleActions(locked, afterClose, holdings()));
    expect(a.settle?.enabled).toBe(true);
    expect(a.claimPool?.enabled).toBe(false);
    expect(a.claimPool?.reason).toMatch(/open once the market settles/);
    expect(a.claimTokens).toBeUndefined();
    expect(a.redeem).toBeUndefined();
  });

  it("graduated: claim tokens when there are some, redeem waits for settlement", () => {
    const m = graduated();
    const none = byId(lifecycleActions(m, before, holdings()));
    expect(none.claimTokens?.enabled).toBe(false);
    expect(none.claimTokens?.reason).toMatch(/No tokens to claim/);
    const some = byId(lifecycleActions(m, before, holdings({ claimableTokens: { yes: USDC(12), no: 0n } })));
    expect(some.claimTokens?.enabled).toBe(true);
    expect(some.claimTokens?.reason).toBe("12.00 YES and 0.00 NO from your stake.");
    expect(some.redeem?.enabled).toBe(false);
    expect(some.redeem?.reason).toMatch(/once the market settles/);
    expect(byId(lifecycleActions(m, before, null)).claimTokens?.reason).toMatch(/Connect a wallet/);
  });

  it("closed: settle opens; void only after the deadline", () => {
    const m = graduated({ phase: Phase.Closed });
    expect(byId(lifecycleActions(m, afterClose, null)).settle?.enabled).toBe(true);
    const late = byId(lifecycleActions(m, afterDeadline, null));
    expect(late.settle?.enabled).toBe(false);
    expect(late.void?.enabled).toBe(true);
  });

  it("settled graduated market: redeem the winning side net of the fixed fee", () => {
    const m = graduated({ phase: Phase.Settled, outcome: Outcome.Yes });
    const a = byId(lifecycleActions(m, afterClose, holdings({ balances: { yes: USDC(100), no: USDC(40) } })));
    expect(a.settle).toBeUndefined();
    expect(a.void).toBeUndefined();
    expect(a.redeem?.enabled).toBe(true);
    const paid = redemptionPayout(USDC(100), USDC(280), USDC(690));
    expect(a.redeem?.redeem).toEqual([{ side: Side.Yes, amount: USDC(100), paid, fee: USDC(100) - paid }]);
    expect(a.redeem?.reason).toMatch(/100\.00 YES for 99\.18 USDC after the fixed 0\.811595 USDC fee/);
    const losers = byId(lifecycleActions(m, afterClose, holdings({ balances: { yes: 0n, no: USDC(40) } })));
    expect(losers.redeem?.enabled).toBe(false);
    expect(losers.redeem?.reason).toMatch(/You hold no YES, the winning side/);
  });

  it("voided graduated market: both sides redeem at 0.50, no fee", () => {
    const m = graduated({ phase: Phase.Voided });
    const a = byId(lifecycleActions(m, afterDeadline, holdings({ balances: { yes: USDC(3), no: 5n } })));
    expect(a.redeem?.redeem).toEqual([
      { side: Side.Yes, amount: USDC(3), paid: USDC(1.5), fee: 0n },
      { side: Side.No, amount: 5n, paid: 2n, fee: 0n },
    ]);
    expect(a.redeem?.reason).toMatch(/at 0\.50 USDC each/);
  });

  it("settled or voided pool-only market: claim the pool payout", () => {
    const settled = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes });
    const win = byId(
      lifecycleActions(
        settled,
        afterClose,
        holdings({ claimablePool: { paid: USDC(124.5), fee: USDC(0.5) } }),
      ),
    );
    expect(win.claimPool?.enabled).toBe(true);
    expect(win.claimPool?.reason).toMatch(/124\.50 USDC after the 2% fee on winnings/);
    const lose = byId(lifecycleActions(settled, afterClose, holdings()));
    expect(lose.claimPool?.enabled).toBe(false);
    const voided = byId(
      lifecycleActions(
        makeMarket({ phase: Phase.Voided }),
        afterDeadline,
        holdings({ claimablePool: { paid: USDC(25), fee: 0n } }),
      ),
    );
    expect(voided.claimPool?.reason).toMatch(/your stake back in full/);
  });
});

describe("redemption math and sets", () => {
  it("charges φ · losing / T per winning token, as Market.feePerToken does", () => {
    const m = graduated();
    // 2% of 280 / 690 = 0.008115 USDC per YES.
    expect(feePerToken(m, Side.Yes)).toBe(8_115n);
    expect(feePerToken(m, Side.No)).toBe(11_884n);
    expect(redeemSteps(graduated({ phase: Phase.Graduated }), { yes: 5n, no: 5n })).toEqual([]);
    expect(redeemSteps(makeMarket({ phase: Phase.Settled }), { yes: 5n, no: 5n })).toEqual([]);
  });

  it("mints only while trading, merges until settlement and after a void", () => {
    expect(setsAvailability(graduated())).toEqual({ mint: null, merge: null });
    expect(setsAvailability(graduated({ phase: Phase.Closed }))).toEqual({
      mint: "Minting stops at close.",
      merge: null,
    });
    expect(setsAvailability(graduated({ phase: Phase.Settled })).merge).toMatch(/stops at settlement/);
    expect(setsAvailability(graduated({ phase: Phase.Voided })).merge).toBeNull();
    expect(setsAvailability(makeMarket()).mint).toMatch(/once the pool graduates/);
  });
});

describe("portfolio plan", () => {
  it("claims, then redeems the claimed tokens too, then claims pools, market by market", () => {
    const settled = graduated({ phase: Phase.Settled, outcome: Outcome.No });
    const pool = makeMarket({ address: "0x00000000000000000000000000000000000000a9", phase: Phase.Settled });
    const entries = [
      makeEntry({
        market: settled,
        claimableTokens: { yes: USDC(10), no: USDC(20) },
        balances: { yes: 0n, no: USDC(5) },
      }),
      makeEntry({ market: pool, claimablePool: { paid: USDC(40), fee: USDC(0.5) } }),
      makeEntry({ market: graduated(), balances: { yes: USDC(1), no: 0n } }),
    ];
    const plan = portfolioPlan(entries);
    expect(plan.map((a) => a.kind)).toEqual(["claimTokens", "redeem", "claimPool"]);
    expect(plan[1]?.side).toBe(Side.No);
    expect(plan[1]?.amount).toBe(USDC(25));
    expect(plan[1]?.paid).toBe(redemptionPayout(USDC(25), USDC(410), USDC(690)));
    expect(plan[2]?.label).toBe("Claim 40.00 USDC pool payout");
    const totals = portfolioTotals(entries);
    expect(totals.payable).toBe((plan[1]?.paid ?? 0n) + USDC(40));
    expect(totals.claimableTokens).toBe(USDC(30));
  });

  it("values tokens at the mid, or at their settled worth", () => {
    const trading = graduated({ quote: { bid: 600_000_000_000_000_000n, ask: 640_000_000_000_000_000n } });
    expect(entryValueAtMid(makeEntry({ market: trading, balances: { yes: USDC(10), no: USDC(10) } }))).toBe(
      USDC(10),
    );
    expect(entryValueAtMid(makeEntry({ market: trading, balances: { yes: USDC(10), no: 0n } }))).toBe(
      USDC(6.2),
    );
    expect(
      entryValueAtMid(makeEntry({ market: graduated(), balances: { yes: USDC(10), no: 0n } })),
    ).toBeNull();
    expect(entryValueAtMid(makeEntry())).toBeNull();
    const voided = graduated({ phase: Phase.Voided });
    expect(entryValueAtMid(makeEntry({ market: voided, balances: { yes: USDC(3), no: USDC(1) } }))).toBe(
      USDC(2),
    );
    expect(entryPlan(makeEntry({ market: voided, balances: { yes: USDC(3), no: USDC(1) } })).length).toBe(2);
  });
});
