import {
  deployments,
  encodeParlayParams,
  encodePriceRangeParams,
  Outcome,
  Phase,
  PriceSource,
  TemplateId,
  type Window,
} from "@hunch-book/shared";
import { type Address, decodeAbiParameters, getAddress, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { SettleDeps, SettleMarket } from "../src/settlers/index.js";
import { type LegState, parlayAnswer, parlaySettler } from "../src/settlers/parlay.js";
import { priceRangeSettler } from "../src/settlers/priceRange.js";
import { fixtureRounds } from "./fixtures.js";

const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const C = getAddress("0x00000000000000000000000000000000000000c3");
const window: Window = { blockClock: false, lock: 0n, close: 0n, settleDeadline: 0n };

const leg = (address: Address, phase: Phase, outcome: Outcome = Outcome.Unresolved): LegState => ({
  address,
  phase,
  outcome,
});

describe("parlayAnswer", () => {
  it("is NO as soon as any leg settles NO, even with others open or voided", () => {
    expect(
      parlayAnswer([leg(A, Phase.Graduated), leg(B, Phase.Settled, Outcome.No), leg(C, Phase.Voided)]),
    ).toEqual({ status: "ready", answer: "no", reason: `leg ${B} settled NO` });
  });

  it("is YES once every leg settled YES", () => {
    expect(
      parlayAnswer([leg(A, Phase.Settled, Outcome.Yes), leg(B, Phase.Settled, Outcome.Yes)]),
    ).toMatchObject({
      status: "ready",
      answer: "yes",
    });
  });

  it("waits while legs are open, and says which", () => {
    const answer = parlayAnswer([leg(A, Phase.Settled, Outcome.Yes), leg(B, Phase.Closed)]);
    expect(answer).toEqual({ status: "wait", reason: `waiting for legs ${B} (Closed)` });
  });

  it("after a leg voids: waits while another leg could still settle NO, then gives up", () => {
    expect(parlayAnswer([leg(A, Phase.Voided), leg(B, Phase.Graduated)]).status).toBe("wait");
    expect(parlayAnswer([leg(A, Phase.Voided), leg(B, Phase.Settled, Outcome.Yes)])).toMatchObject({
      status: "unsettleable",
    });
  });
});

describe("the parlay settler", () => {
  const params = encodeParlayParams({ legs: [B, A], lockTime: 100n, closeTime: 200n });
  const market: SettleMarket = { address: C, templateId: TemplateId.Parlay, params, window, resolver: C };

  it("waits for its close, then reads every leg in one multicall", async () => {
    expect(parlaySettler.waitReason(market, { block: 0n, timestamp: 199n })).toMatch(
      /^waiting for close at 200/,
    );
    expect(parlaySettler.waitReason(market, { block: 0n, timestamp: 200n })).toBeNull();
    const seen: unknown[] = [];
    const client = {
      async multicall(req: { contracts: { address: Address; functionName: string }[] }) {
        seen.push(req.contracts.map((c) => `${c.address}.${c.functionName}`));
        // Legs in canonical order: A, then B.
        return [Phase.Settled, Outcome.Yes, Phase.Settled, Outcome.Yes];
      },
    } as unknown as PublicClient;
    const deps = {
      client,
      deployment: deployments["monad-testnet"],
      pythApiKey: undefined,
      hermesUrl: "",
    } as SettleDeps;
    const result = await parlaySettler.evidence(market, { block: 0n, timestamp: 300n }, deps);
    expect(result).toMatchObject({
      status: "ready",
      evidence: "0x",
      detail: { answer: "yes", legs: [A, B] },
    });
    expect(seen).toEqual([[`${A}.phase`, `${A}.outcome`, `${B}.phase`, `${B}.outcome`]]);
  });
});

describe("the price range settler", () => {
  const rounds = fixtureRounds("btc-usd");
  const target = ((rounds[150]?.updatedAt ?? 0n) + (rounds[151]?.updatedAt ?? 0n)) / 2n;
  const feed = deployments["monad-mainnet"].external.chainlink["BTC/USD"] as Address;
  const market: SettleMarket = {
    address: C,
    templateId: TemplateId.PriceRange,
    params: encodePriceRangeParams({
      source: PriceSource.Chainlink,
      feed,
      pythId: `0x${"00".repeat(32)}`,
      lowerE8: 80_000n * 10n ** 8n,
      upperE8: 85_000n * 10n ** 8n,
      lockTime: target - 3_600n,
      closeTime: target,
    }),
    window,
    resolver: C,
  };
  const byId = new Map(rounds.map((r) => [r.roundId, r]));
  const client = {
    async readContract(req: { functionName: string; args?: unknown[] }) {
      const tuple = (r: (typeof rounds)[number]) => [
        r.roundId,
        r.answer,
        r.updatedAt,
        r.updatedAt,
        r.roundId,
      ];
      if (req.functionName === "latestRoundData") return tuple(rounds.at(-1) as (typeof rounds)[number]);
      const r = byId.get(req.args?.[0] as bigint);
      if (!r) throw new Error("execution reverted");
      return tuple(r);
    },
  } as unknown as PublicClient;
  const deps = {
    client,
    deployment: deployments["monad-mainnet"],
    pythApiKey: undefined,
    hermesUrl: "",
  } as SettleDeps;

  it("passes the same bracketing round as template 2, after T", async () => {
    expect(priceRangeSettler.waitReason(market, { block: 0n, timestamp: target })).toMatch(
      /^waiting for time >/,
    );
    const result = await priceRangeSettler.evidence(market, { block: 0n, timestamp: target + 1n }, deps);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const [roundId] = decodeAbiParameters([{ type: "uint80" }], result.evidence);
    expect(roundId).toBe(rounds[150]?.roundId);
    expect(result.detail).toMatchObject({ source: "chainlink", lowerE8: 80_000n * 10n ** 8n });
  });
});
