import {
  decodeChainlinkTouchParams,
  EMPTY_EVIDENCE,
  encodeRoundEvidence,
  TOUCH_CHALLENGE_SECONDS,
  TouchDirection,
} from "@hunch-book/shared";
import type { Address, PublicClient } from "viem";
import { chainlinkFeedAbi } from "../abis.js";
import type { Prover, Settler } from "./index.js";
import { iso } from "./priceAtTime.js";
import { chainlinkTouchReader, huntTouch, type TouchHunt, type TouchReader } from "./touchRounds.js";

// Template 3, price touch (docs/TEMPLATES.md). YES is proved by pointing at the Chainlink round that
// touched the strike: the prover reads every round of [T1, T2] as it is written and sends
// `proveYes(abi.encode(roundId))` as soon as one touches. NO needs no proof: once the 24-hour challenge
// period after T2 is over, `settle(0x)` settles NO, provided the feed reported at or after T2. The keeper
// only sends that NO after it has read every round of the window and none touched: it is the honest
// prover the template's NO relies on.

export interface TouchSettlerOptions {
  /** Builds the round reader for a feed (tests pass one over recorded rounds). */
  reader?: (client: PublicClient, feed: Address) => TouchReader;
  /** Round reads one hunt may spend per cycle. */
  maxReads?: number;
}

const describeDirection = (d: number) => (d === TouchDirection.AtOrAbove ? "at or above" : "at or below");

export function chainlinkTouchSettler(options: TouchSettlerOptions = {}): Settler {
  const makeReader = options.reader ?? chainlinkTouchReader;
  const maxReads = options.maxReads ?? 2_000;
  const hunts = new Map<Address, TouchHunt>();

  const question = (params: `0x${string}`) => {
    const p = decodeChainlinkTouchParams(params);
    return {
      p,
      q: { strikeE8: p.strikeE8, direction: p.direction, startTime: p.startTime, endTime: p.endTime },
    };
  };

  const prover: Prover = {
    waitReason(market, now) {
      const { p } = question(market.params);
      if (now.timestamp < p.startTime) {
        return `waiting for the window to open at ${p.startTime} (${iso(p.startTime)})`;
      }
      const hunt = hunts.get(market.address);
      if (hunt?.complete && !hunt.found) {
        const challengeEnd = p.endTime + TOUCH_CHALLENGE_SECONDS;
        return `no round in the window touched ${p.strikeE8} (${hunt.checked} rounds read): NO settles at ${challengeEnd} (${iso(challengeEnd)})`;
      }
      return null;
    },

    async findProof(market, now, deps) {
      const { p, q } = question(market.params);
      const scan = await huntTouch(
        makeReader(deps.client, p.feed),
        q,
        hunts.get(market.address),
        now.timestamp,
        maxReads,
      );
      if (scan.hunt) hunts.set(market.address, scan.hunt);
      if (scan.status === "none") return { status: "none", reason: scan.reason };
      return {
        status: "found",
        proof: encodeRoundEvidence(scan.round.roundId),
        detail: {
          feed: p.feed,
          roundId: scan.round.roundId,
          answer: scan.round.answer,
          updatedAt: scan.round.updatedAt,
          priceE8: scan.round.priceE8,
          strikeE8: p.strikeE8,
          direction: describeDirection(p.direction),
          roundsRead: scan.hunt.checked,
          reads: scan.reads,
        },
      };
    },
  };

  return {
    name: "chainlink-touch",
    prover,

    waitReason(market, now) {
      const { p } = question(market.params);
      const challengeEnd = p.endTime + TOUCH_CHALLENGE_SECONDS;
      // A touch is proved through `proveYes` (the prove job); `settle` here is the NO path.
      return now.timestamp >= challengeEnd
        ? null
        : `waiting for the challenge period to end at ${challengeEnd} (${iso(challengeEnd)}) before NO`;
    },

    async evidence(market, now, deps) {
      const { p, q } = question(market.params);
      const scan = await huntTouch(
        makeReader(deps.client, p.feed),
        q,
        hunts.get(market.address),
        now.timestamp,
        maxReads,
      );
      if (scan.hunt) hunts.set(market.address, scan.hunt);
      if (scan.status === "found") {
        // A touch the prove job has not landed yet: settling with it settles YES.
        return {
          status: "ready",
          evidence: encodeRoundEvidence(scan.round.roundId),
          value: 0n,
          detail: { answer: "yes", feed: p.feed, roundId: scan.round.roundId, priceE8: scan.round.priceE8 },
        };
      }
      if (!scan.hunt?.complete) {
        return { status: "wait", reason: `NO waits until every round of the window is read: ${scan.reason}` };
      }
      const [latestId, , , latestUpdatedAt] = await deps.client.readContract({
        address: p.feed,
        abi: chainlinkFeedAbi,
        functionName: "latestRoundData",
      });
      if (latestUpdatedAt < p.endTime) {
        return {
          status: "wait",
          reason: `the feed has not reported since the window ended (latest round ${latestId} at ${latestUpdatedAt}); the resolver needs one before NO`,
        };
      }
      return {
        status: "ready",
        evidence: EMPTY_EVIDENCE,
        value: 0n,
        detail: {
          answer: "no",
          feed: p.feed,
          strikeE8: p.strikeE8,
          direction: describeDirection(p.direction),
          roundsRead: scan.hunt.checked,
          closestE8: scan.hunt.closest,
          latestRound: latestId,
        },
      };
    },
  };
}
