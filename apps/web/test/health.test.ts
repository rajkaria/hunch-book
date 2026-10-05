import { Phase, TemplateId } from "@hunch-book/shared";
import { describe, expect, it } from "vitest";
import { gradeOf, type HealthInput, healthLabel, marketHealth } from "../src/lib/health/score";

const NOW = 1_800_000_000;
const base: HealthInput = {
  phase: Phase.Graduated,
  graduated: true,
  templateId: TemplateId.PerplFunding,
  network: "monad-testnet",
  bid: 0.48,
  ask: 0.5,
  pool: { yesUsdc: 300, noUsdc: 300, stakers: 12 },
  rule: { minPoolUsdc: 500, minStakers: 10 },
  now: NOW,
  closeAt: NOW + 3 * 86_400,
};
const part = (h: ReturnType<typeof marketHealth>, name: string) => h.parts.find((p) => p.name === name);

describe("market health", () => {
  it("gives full marks to a tight, deep Perpl book with days to run", () => {
    const h = marketHealth({ ...base, depthUsdc: 800 });
    expect(h.score).toBe(100);
    expect(h.grade).toBe("good");
    expect(part(h, "liquidity")?.why).toBe("2.0 cent spread, 800 USDC within 5 cents of the mid.");
  });

  it("scores liquidity from the spread alone when depth was not read", () => {
    const tight = marketHealth(base);
    expect(part(tight, "liquidity")?.points).toBe(50);
    expect(part(tight, "liquidity")?.why).toContain("depth is on the market page");
    const mid = marketHealth({ ...base, bid: 0.4, ask: 0.51 });
    expect(part(mid, "liquidity")?.points).toBe(25);
    const wide = marketHealth({ ...base, bid: 0.2, ask: 0.6 });
    expect(part(wide, "liquidity")?.points).toBe(0);
  });

  it("gives no liquidity to a book with an empty side", () => {
    const h = marketHealth({ ...base, bid: null });
    expect(part(h, "liquidity")?.points).toBe(0);
    expect(part(h, "liquidity")?.why).toContain("empty");
  });

  it("scores a pool by its way to graduation", () => {
    const pool = { ...base, phase: Phase.Pool, graduated: false, bid: null, ask: null };
    const full = marketHealth({ ...pool, pool: { yesUsdc: 300, noUsdc: 250, stakers: 10 } });
    expect(part(full, "liquidity")?.points).toBe(50);
    const half = marketHealth({ ...pool, pool: { yesUsdc: 250, noUsdc: 0, stakers: 5 } });
    expect(part(half, "liquidity")?.points).toBe(20);
    expect(part(half, "liquidity")?.why).toContain("one side has no stake yet");
  });

  it("takes time points away as close nears", () => {
    expect(part(marketHealth(base), "time")?.points).toBe(20);
    expect(part(marketHealth({ ...base, closeAt: NOW + 12 * 3_600 }), "time")?.points).toBe(15);
    expect(part(marketHealth({ ...base, closeAt: NOW + 1_800 }), "time")?.points).toBe(3);
    expect(part(marketHealth({ ...base, closeAt: NOW + 1_800 }), "time")?.why).toBe("Closes in 30 minutes.");
  });

  it("counts a pool's time to its lock, when staking ends", () => {
    const pool = {
      ...base,
      phase: Phase.Pool,
      graduated: false,
      lockAt: NOW + 1_800,
      closeAt: NOW + 86_400 * 3,
    };
    expect(part(marketHealth(pool), "time")).toMatchObject({ points: 3, why: "Staking ends in 30 minutes." });
    const locked = { ...pool, phase: Phase.PoolLocked, closeAt: NOW + 7_200 };
    expect(part(marketHealth(locked), "time")?.why).toBe("Staking has ended; closes in 2 hours.");
  });

  it("is healthy right after close and loses time points while settlement is overdue", () => {
    const closed = { ...base, phase: Phase.Closed, closeAt: NOW - 600 };
    expect(part(marketHealth(closed), "time")?.points).toBe(20);
    const late = marketHealth({ ...closed, closeAt: NOW - 12.5 * 3_600 });
    expect(part(late, "time")?.points).toBe(10);
    expect(part(late, "time")?.why).toContain("waiting for settlement for 13 hours");
    expect(part(marketHealth({ ...closed, closeAt: NOW - 2 * 86_400 }), "time")?.points).toBe(0);
  });

  it("does not count a touch market's challenge period as overdue", () => {
    const h = marketHealth({
      ...base,
      phase: Phase.Closed,
      templateId: TemplateId.ChainlinkTouch,
      closeAt: NOW - 3_600,
      settleFrom: NOW + 20 * 3_600,
    });
    expect(part(h, "time")?.points).toBe(20);
    expect(part(h, "time")?.why).toBe("Closed; settlement opens in 20 hours.");
  });

  it("rates sources by how reliably their answer can be read on the network", () => {
    const src = (templateId: number, network: HealthInput["network"] = "monad-testnet") =>
      part(marketHealth({ ...base, templateId, network }), "source")?.points;
    expect(src(TemplateId.PerplFunding)).toBe(30);
    expect(src(TemplateId.PerplFundingSpike)).toBe(30);
    expect(src(TemplateId.PriceAtTime)).toBe(15);
    expect(src(TemplateId.PriceAtTime, "monad-mainnet")).toBe(30);
    expect(src(TemplateId.Snapshot)).toBe(20);
    expect(src(TemplateId.Parlay)).toBe(20);
    expect(src(99)).toBe(0);
  });

  it("has no score once settled or voided", () => {
    for (const phase of [Phase.Settled, Phase.Voided]) {
      const h = marketHealth({ ...base, phase });
      expect(h).toEqual({ score: null, grade: "finished", parts: [] });
      expect(healthLabel(h)).toBe("Finished");
    }
    expect(healthLabel(marketHealth({ ...base, templateId: TemplateId.Snapshot }))).toBe("Health 90");
  });

  it("grades at 70 and 40", () => {
    expect([gradeOf(70), gradeOf(69), gradeOf(40), gradeOf(39)]).toEqual(["good", "fair", "fair", "thin"]);
  });

  it("never leaves 0 to 100, whatever the inputs", () => {
    const odd = marketHealth({
      ...base,
      bid: 0.9,
      ask: 0.1,
      depthUsdc: Number.POSITIVE_INFINITY,
      closeAt: Number.NaN,
      pool: { yesUsdc: -5, noUsdc: 1e12, stakers: 1e9 },
    });
    expect(odd.score).toBeGreaterThanOrEqual(0);
    expect(odd.score).toBeLessThanOrEqual(100);
  });
});
