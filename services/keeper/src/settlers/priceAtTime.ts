import { decodePriceAtTimeParams, PriceSource } from "@hunch-book/shared";
import { encodeAbiParameters, type Hex, parseAbi } from "viem";
import { pythAbi } from "../abis.js";
import { chainlinkReader, findBracketingRound } from "./chainlink.js";
import type { Settler } from "./index.js";
import { fetchHermesUpdate } from "./pyth.js";

// Template 2, price at a time (docs/PROTOCOL.md §6.2). The resolver answers once block.timestamp > T.
// - Chainlink (source 0): evidence = abi.encode(uint80 r), r the round that brackets T.
// - Pyth (source 1): evidence = abi.encode(bytes[] updateData), the first update at or after T from
//   Hermes, sent with value = Pyth's update fee (the resolver refunds anything above it).

const resolverPythAbi = parseAbi(["function pyth() view returns (address)"]);

export function encodeChainlinkEvidence(roundId: bigint): Hex {
  return encodeAbiParameters([{ type: "uint80" }], [roundId]);
}

export function encodePythEvidence(updateData: Hex[]): Hex {
  return encodeAbiParameters([{ type: "bytes[]" }], [updateData]);
}

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

export const priceAtTimeSettler: Settler = {
  name: "price-at-time",

  waitReason(market, now) {
    const p = decodePriceAtTimeParams(market.params);
    return now.timestamp > p.closeTime ? null : `waiting for time > ${p.closeTime} (${iso(p.closeTime)})`;
  },

  async evidence(market, _now, deps) {
    const p = decodePriceAtTimeParams(market.params);
    if (p.source === PriceSource.Chainlink) {
      const found = await findBracketingRound(chainlinkReader(deps.client, p.feed), p.closeTime);
      if (found.status !== "found") return { status: found.status, reason: found.reason };
      return {
        status: "ready",
        evidence: encodeChainlinkEvidence(found.round.roundId),
        value: 0n,
        detail: {
          source: "chainlink",
          feed: p.feed,
          roundId: found.round.roundId,
          answer: found.round.answer,
          updatedAt: found.round.updatedAt,
          nextUpdatedAt: found.next.updatedAt,
          target: p.closeTime,
          reads: found.reads,
        },
      };
    }
    if (p.source === PriceSource.Pyth) {
      const result = await fetchHermesUpdate({
        baseUrl: deps.hermesUrl,
        apiKey: deps.pythApiKey,
        id: p.pythId,
        target: p.closeTime,
        fetchFn: deps.fetchFn,
      });
      if (result.status !== "found") return result;
      const pyth = await deps.client.readContract({
        address: market.resolver,
        abi: resolverPythAbi,
        functionName: "pyth",
      });
      const fee = await deps.client.readContract({
        address: pyth,
        abi: pythAbi,
        functionName: "getUpdateFee",
        args: [result.update.updateData],
      });
      return {
        status: "ready",
        evidence: encodePythEvidence(result.update.updateData),
        value: fee,
        detail: {
          source: "pyth",
          pythId: p.pythId,
          publishTime: result.update.publishTime,
          price: result.update.price,
          expo: result.update.expo,
          target: p.closeTime,
          fee,
        },
      };
    }
    return { status: "unsettleable", reason: `unknown price source ${String(p.source)}` };
  },
};
