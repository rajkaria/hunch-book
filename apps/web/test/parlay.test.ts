import { decodeParlayParams, encodeParlayParams, Outcome, Phase, TemplateId } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { parsePrefill } from "../src/lib/ladder/prefill";
import type { MarketView } from "../src/lib/market/types";
import {
  earliestLock,
  LOCK_MARGIN_SECONDS,
  latestClose,
  legBlocker,
  legState,
  oneIn,
  parlayChanceBps,
  parlayLegsOf,
  parlayPrefillPath,
  parlayQuote,
  parlayView,
  parlayWindow,
} from "../src/lib/parlay/math";
import { clock, makeMarket } from "./fixtures";

const NOW = 1_799_000_000;
const A = "0x00000000000000000000000000000000000000a3" as Address;
const B = "0x00000000000000000000000000000000000000a1" as Address;
const C = "0x00000000000000000000000000000000000000a2" as Address;

function leg(address: Address, yesBps: number, over: Partial<MarketView> = {}): MarketView {
  const yes = BigInt(yesBps) * 1_000n;
  const no = BigInt(10_000 - yesBps) * 1_000n;
  return makeMarket({ address, pool: { yes, no, total: yes + no, stakers: 5 }, ...over });
}

describe("parlay chance", () => {
  it("multiplies the legs' chances, rounding down to a basis point", () => {
    expect(parlayChanceBps([5_000n, 5_000n])).toBe(2_500n);
    expect(parlayChanceBps([6_000n, 5_000n, 3_333n])).toBe(999n);
    expect(parlayChanceBps([10_000n, 10_000n, 10_000n, 10_000n, 10_000n])).toBe(10_000n);
    expect(parlayChanceBps([3_333n, 3_333n, 3_333n, 3_333n, 3_333n])).toBe(41n);
  });

  it("has no chance when a leg has none, or with no legs", () => {
    expect(parlayChanceBps([5_000n, null])).toBeNull();
    expect(parlayChanceBps([])).toBeNull();
  });

  it("clamps out-of-range inputs", () => {
    expect(parlayChanceBps([12_000n, -5n])).toBe(0n);
  });

  it("says the odds as 1 in N", () => {
    expect(oneIn(2_500n)).toBe("about 1 in 4");
    expect(oneIn(41n)).toBe("about 1 in 244");
    expect(oneIn(9_990n)).toBe("almost certain, by these prices");
    expect(oneIn(0n)).toBeNull();
  });

  it("quotes from each leg's own chance", () => {
    expect(parlayQuote([leg(A, 5_000), leg(B, 4_000)])).toEqual({
      legs: [5_000n, 4_000n],
      chanceBps: 2_000n,
    });
  });
});

describe("parlay timing", () => {
  it("estimates a block-clock leg's lock fast and its close slow", () => {
    const blocky = makeMarket({
      window: {
        blockClock: true,
        lock: clock.blockNumber + 10_000n,
        close: clock.blockNumber + 20_000n,
        settleDeadline: 0n,
      },
    });
    expect(earliestLock(blocky, clock)).toBe(clock.timestamp + 2_000);
    expect(latestClose(blocky, clock)).toBe(clock.timestamp + 20_000);
    expect(earliestLock(blocky, null)).toBeNull();
    expect(earliestLock(makeMarket(), null)).toBe(1_800_000_000);
  });

  it("locks before the earliest leg and closes after the last one", () => {
    const early = leg(A, 5_000, {
      window: {
        blockClock: false,
        lock: BigInt(NOW + 10_000),
        close: BigInt(NOW + 20_000),
        settleDeadline: 0n,
      },
    });
    const late = leg(B, 5_000, {
      window: {
        blockClock: false,
        lock: BigInt(NOW + 50_000),
        close: BigInt(NOW + 90_000),
        settleDeadline: 0n,
      },
    });
    expect(parlayWindow([early, late], null, NOW)).toEqual({
      lockTime: BigInt(NOW + 10_000 - LOCK_MARGIN_SECONDS),
      closeTime: BigInt(NOW + 90_000),
    });
    const soon = leg(C, 5_000, {
      window: { blockClock: false, lock: BigInt(NOW + 900), close: BigInt(NOW + 2_000), settleDeadline: 0n },
    });
    expect(parlayWindow([soon, late], null, NOW)).toBeNull();
    expect(parlayWindow([], null, NOW)).toBeNull();
  });

  it("explains why a market cannot be a leg", () => {
    expect(legBlocker(leg(A, 5_000), null, NOW)).toBeNull();
    expect(legBlocker(leg(A, 5_000, { phase: Phase.Settled }), null, NOW)).toBe("Already settled or voided.");
    expect(legBlocker(leg(A, 5_000, { phase: Phase.Closed }), null, NOW)).toBe("Already locked.");
    expect(legBlocker(leg(A, 5_000), null, 1_800_000_001)).toBe("Already locked.");
    expect(legBlocker(leg(A, 5_000), null, 1_800_000_000 - 1_000)).toMatch(/^Locks too soon/);
    const blocky = makeMarket({
      window: { blockClock: true, lock: 2_000_000n, close: 2_000_100n, settleDeadline: 0n },
    });
    expect(legBlocker(blocky, null, NOW)).toBe("Reading the chain clock...");
    // A block lock the head has passed is locked, even while \`now\` lags the head's time.
    const passed = makeMarket({
      window: {
        blockClock: true,
        lock: clock.blockNumber - 5n,
        close: clock.blockNumber + 100n,
        settleDeadline: 0n,
      },
    });
    expect(earliestLock(passed, clock)).toBeLessThan(clock.timestamp);
    expect(legBlocker(passed, clock, clock.timestamp - 10)).toBe("Already locked.");
  });
});

describe("parlay prefill", () => {
  it("encodes the legs in the one order the resolver accepts, with the window", () => {
    const path = parlayPrefillPath([A, B, C], { lockTime: 10n, closeTime: 20n });
    const prefill = parsePrefill(new URL(path, "https://x").searchParams);
    expect(prefill?.templateId).toBe(TemplateId.Parlay);
    const params = decodeParlayParams(prefill?.params ?? "0x");
    expect(params.legs.map((l) => l.toLowerCase())).toEqual([B, C, A]);
    expect(params).toMatchObject({ lockTime: 10n, closeTime: 20n });
    expect(path.endsWith("from=parlay")).toBe(true);
  });

  it("refuses a repeated leg or a wrong count", () => {
    expect(() => parlayPrefillPath([A, A], { lockTime: 1n, closeTime: 2n })).toThrow(/twice/);
    expect(() => parlayPrefillPath([A], { lockTime: 1n, closeTime: 2n })).toThrow(/2 to 5 legs/);
  });
});

describe("existing parlays", () => {
  const parlay = (legs: Address[]) =>
    makeMarket({
      address: "0x00000000000000000000000000000000000000f9",
      templateId: TemplateId.Parlay,
      params: encodeParlayParams({ legs, lockTime: 1n, closeTime: 2n }),
    });

  it("reads its legs and their states", () => {
    expect(parlayLegsOf(parlay([A, B]))?.map((a) => a.toLowerCase())).toEqual([B, A]);
    expect(parlayLegsOf(makeMarket())).toBeNull();
    expect(legState(null)).toBe("unknown");
    expect(legState(leg(A, 5_000, { phase: Phase.Settled, outcome: Outcome.No }))).toBe("no");
    expect(legState(leg(A, 5_000, { phase: Phase.Voided }))).toBe("void");
  });

  it("is NO once any leg is NO, YES once all are YES, and prices settled YES legs as certain", () => {
    const known = (...ms: MarketView[]) => new Map(ms.map((m) => [m.address.toLowerCase(), m]));
    const open = parlayView(parlay([A, B]), known(leg(A, 5_000), leg(B, 4_000)));
    expect(open?.verdict).toBe("open");
    expect(open?.impliedBps).toBe(2_000n);
    const oneYes = parlayView(
      parlay([A, B]),
      known(leg(A, 5_000, { phase: Phase.Settled, outcome: Outcome.Yes }), leg(B, 4_000)),
    );
    expect(oneYes?.impliedBps).toBe(4_000n);
    const no = parlayView(
      parlay([A, B]),
      known(leg(A, 5_000, { phase: Phase.Settled, outcome: Outcome.No }), leg(B, 4_000)),
    );
    expect(no?.verdict).toBe("no");
    expect(no?.impliedBps).toBe(0n);
    const voided = parlayView(parlay([A, B]), known(leg(A, 5_000, { phase: Phase.Voided }), leg(B, 4_000)));
    expect(voided?.verdict).toBe("void");
    const unknown = parlayView(parlay([A, B]), known(leg(A, 5_000)));
    expect(unknown?.legs.find((l) => l.state === "unknown")).toBeDefined();
    expect(unknown?.impliedBps).toBeNull();
  });
});
