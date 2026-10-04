import { Phase } from "@hunch-book/shared";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  deckOrder,
  dragIntent,
  dragTransform,
  isOpen,
  keyIntent,
  SWIPE_THRESHOLD,
  stampOpacity,
  withSkip,
} from "../src/lib/feed/deck";
import type { MarketView } from "../src/lib/market/types";
import { clock, makeMarket } from "./fixtures";

const NOW = 1_799_000_000;
let n = 0;
const at = (lockIn: number, over: Partial<MarketView> = {}): MarketView =>
  makeMarket({
    address: `0x${(0xf00 + ++n).toString(16).padStart(40, "0")}` as Address,
    marketId: BigInt(n),
    window: {
      blockClock: false,
      lock: BigInt(NOW + lockIn),
      close: BigInt(NOW + lockIn + 86_400),
      settleDeadline: 0n,
    },
    ...over,
  });

describe("which markets are in the deck", () => {
  it("keeps pools before their lock and books before their close", () => {
    expect(isOpen(at(60), clock, NOW)).toBe(true);
    expect(isOpen(at(-60), clock, NOW)).toBe(false);
    expect(isOpen(at(-60, { phase: Phase.Graduated }), clock, NOW)).toBe(true);
    expect(isOpen(at(-90_000, { phase: Phase.Graduated }), clock, NOW)).toBe(false);
    expect(isOpen(at(60, { phase: Phase.Closed }), clock, NOW)).toBe(false);
    expect(isOpen(at(60, { phase: Phase.Settled }), clock, NOW)).toBe(false);
  });

  it("puts the soonest deadline first and leaves out what was skipped", () => {
    const later = at(5_000);
    const sooner = at(100);
    const closed = at(-100);
    const deck = deckOrder([later, closed, sooner], clock, NOW);
    expect(deck.map((m) => m.address)).toEqual([sooner.address, later.address]);
    const skipped = withSkip(new Set(), sooner.address.toUpperCase() as Address);
    expect(deckOrder([later, sooner], clock, NOW, skipped).map((m) => m.address)).toEqual([later.address]);
  });

  it("orders block-clock markets it cannot time after the timed ones, newest first", () => {
    const blockA = at(0, {
      window: { blockClock: true, lock: 2_000_000n, close: 2_100_000n, settleDeadline: 0n },
    });
    const blockB = at(0, {
      window: { blockClock: true, lock: 2_000_000n, close: 2_100_000n, settleDeadline: 0n },
    });
    const timed = at(100);
    expect(deckOrder([blockA, timed, blockB], null, NOW).map((m) => m.address)).toEqual([
      timed.address,
      blockB.address,
      blockA.address,
    ]);
  });
});

describe("gestures and keys", () => {
  it("reads a sideways drag as YES or NO, an upward one as skip, and a short one as nothing", () => {
    expect(dragIntent(SWIPE_THRESHOLD, 0)).toBe("yes");
    expect(dragIntent(-SWIPE_THRESHOLD - 1, 20)).toBe("no");
    expect(dragIntent(10, -SWIPE_THRESHOLD)).toBe("skip");
    expect(dragIntent(SWIPE_THRESHOLD - 1, 30)).toBeNull();
    expect(dragIntent(120, -200)).toBe("skip");
  });

  it("maps the arrow keys and letters", () => {
    expect(keyIntent("ArrowRight")).toBe("yes");
    expect(keyIntent("y")).toBe("yes");
    expect(keyIntent("N")).toBe("no");
    expect(keyIntent("ArrowDown")).toBe("skip");
    expect(keyIntent("Enter")).toBeNull();
  });

  it("tilts the card only when motion is allowed", () => {
    expect(dragTransform(160, 10, false)).toBe("translate3d(160.0px, 10.0px, 0) rotate(10.00deg)");
    expect(dragTransform(160, 10, true)).toBe("translate3d(160.0px, 10.0px, 0) rotate(0.00deg)");
    expect(dragTransform(-400, 90, false)).toContain("rotate(-14.00deg)");
  });

  it("fades the YES and NO stamps in as the card moves", () => {
    expect(stampOpacity(0, "yes")).toBe(0);
    expect(stampOpacity(SWIPE_THRESHOLD, "yes")).toBe(1);
    expect(stampOpacity(-SWIPE_THRESHOLD, "no")).toBe(1);
    expect(stampOpacity(-SWIPE_THRESHOLD, "yes")).toBe(0);
  });
});
