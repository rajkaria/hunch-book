import {
  chainlinkEvidence,
  EMPTY_EVIDENCE,
  encodeFundingEventEvidence,
  encodeRoundEvidence,
  marketAbi,
  Outcome,
  Phase,
  PriceSource,
  resolverAbi,
  snapshotWindowState,
  TOUCH_CHALLENGE_SECONDS,
} from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import type { HunchContext } from "../context.js";
import { describeError, withKnownErrors } from "../errors.js";
import { type MarketInfo, OUTCOME_LABEL, type OutcomeLabel, requireMarket } from "../markets.js";
import { multicall, ok } from "../multicall.js";
import { findBracket, scanTouches } from "./chainlink.js";
import { perplResolverAbi, resolverExchange, scanSpikes } from "./perpl.js";
import { fetchHermesUpdate, pythEvidence, pythFeeAbi, resolverPythAbi } from "./pyth.js";
import { storedSnapshot } from "./snapshot.js";

// Finds the evidence `settle` (or `proveYes`) needs for any market on templates 1 to 7, then runs the
// market's resolver with it as a call, from the market's own address, so the plan says exactly what
// settling now would store. Nothing here sends a transaction.

export type SettlementMethod = "settle" | "proveYes";

export type SettlementPlan =
  /** Call `method(evidence)` on the market with `value` MON: it settles with `outcome`. */
  | {
      status: "ready";
      method: SettlementMethod;
      evidence: Hex;
      value: bigint;
      outcome: Outcome;
      outcomeLabel: OutcomeLabel;
      evidenceHash: Hex;
      detail: Record<string, unknown>;
    }
  /** Not yet: the source has no final answer. Try again later. */
  | { status: "wait"; reason: string; detail?: Record<string, unknown> }
  /** No evidence settles it from here (the resolver refuses, or a Pyth update cannot be fetched). */
  | { status: "blocked"; reason: string; detail?: Record<string, unknown> }
  /** Past the settlement deadline: the only action is `voidIfExpired`. */
  | { status: "expired"; reason: string }
  /** Already settled or voided. */
  | { status: "final"; reason: string; outcome: Outcome };

export interface ChainNow {
  block: bigint;
  timestamp: bigint;
}

export async function chainNow(ctx: HunchContext): Promise<ChainNow> {
  const block = await ctx.publicClient.getBlock({ blockTag: "latest" });
  return { block: block.number, timestamp: block.timestamp };
}

/** Runs the resolver as `settle` would, from the market's address. No transaction. */
export async function dryRunResolve(
  ctx: HunchContext,
  m: Pick<MarketInfo, "address" | "resolver" | "params">,
  evidence: Hex,
  value = 0n,
): Promise<{ outcome: Outcome; evidenceHash: Hex }> {
  const { result } = await ctx.publicClient.simulateContract({
    address: m.resolver,
    abi: withKnownErrors(resolverAbi),
    functionName: "resolve",
    args: [m.params, evidence],
    account: m.address,
    value,
  });
  const [outcome, evidenceHash] = result as readonly [number, Hex];
  return { outcome: Number(outcome) as Outcome, evidenceHash };
}

type Found =
  | {
      kind: "evidence";
      method: SettlementMethod;
      evidence: Hex;
      value: bigint;
      detail: Record<string, unknown>;
    }
  | { kind: "wait" | "blocked"; reason: string; detail?: Record<string, unknown> };

const iso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

async function findEvidence(
  ctx: HunchContext,
  m: MarketInfo,
  now: ChainNow,
  closed: boolean,
): Promise<Found> {
  const d = m.decoded;
  switch (d.kind) {
    case "perpl-funding": {
      const p = d.params;
      if (now.block <= p.endBlock) {
        return {
          kind: "wait",
          reason: `Waiting for block ${p.endBlock + 1n}: Perpl's funding is final only after the window's last block.`,
        };
      }
      return {
        kind: "evidence",
        method: "settle",
        evidence: EMPTY_EVIDENCE,
        value: 0n,
        detail: { endBlock: p.endBlock },
      };
    }

    case "price-at-time":
    case "price-range": {
      const p = d.params;
      if (now.timestamp <= p.closeTime)
        return { kind: "wait", reason: `Waiting for the close at ${iso(p.closeTime)}.` };
      if (p.source === PriceSource.Chainlink) {
        const b = await findBracket(ctx, p.feed, p.closeTime);
        switch (b.status) {
          case "waiting":
            return {
              kind: "wait",
              reason: `Waiting for Chainlink's first round after the close. The feed last updated at ${iso(b.latest.updatedAt)}.`,
            };
          case "stale":
            return {
              kind: "blocked",
              reason: `Chainlink's last round before the close is ${b.staleSeconds} seconds older than the close, more than the one hour the resolver accepts. The market voids at its deadline.`,
              detail: { roundId: b.round.roundId, updatedAt: b.round.updatedAt },
            };
          case "phase-start":
            return {
              kind: "blocked",
              reason:
                "Chainlink's feed moved to a new phase after the close, so no round brackets it. The market voids at its deadline.",
            };
          case "found":
            return {
              kind: "evidence",
              method: "settle",
              evidence: chainlinkEvidence(b.round.roundId),
              value: 0n,
              detail: {
                source: "chainlink",
                feed: p.feed,
                roundId: b.round.roundId,
                answer: b.round.answer,
                updatedAt: b.round.updatedAt,
                nextUpdatedAt: b.next.updatedAt,
                target: p.closeTime,
              },
            };
        }
        break;
      }
      const hermes = await fetchHermesUpdate(ctx.pyth, p.pythId, p.closeTime);
      if (hermes.status !== "found") {
        return { kind: hermes.status === "wait" ? "wait" : "blocked", reason: hermes.reason };
      }
      const pyth = await ctx.publicClient.readContract({
        address: m.resolver,
        abi: resolverPythAbi,
        functionName: "pyth",
      });
      const fee = await ctx.publicClient.readContract({
        address: pyth,
        abi: pythFeeAbi,
        functionName: "getUpdateFee",
        args: [hermes.update.updateData],
      });
      return {
        kind: "evidence",
        method: "settle",
        evidence: pythEvidence(hermes.update.updateData),
        value: fee,
        detail: { source: "pyth", pythId: p.pythId, publishTime: hermes.update.publishTime, fee },
      };
    }

    case "chainlink-touch": {
      const p = d.params;
      if (now.timestamp < p.startTime)
        return { kind: "wait", reason: `The window opens at ${iso(p.startTime)}.` };
      const scan = await scanTouches(ctx, p, { until: now.timestamp });
      const touch = scan.touches[0];
      if (touch) {
        return {
          kind: "evidence",
          method: closed ? "settle" : "proveYes",
          evidence: encodeRoundEvidence(touch.roundId),
          value: 0n,
          detail: {
            roundId: touch.roundId,
            answer: touch.answer,
            updatedAt: touch.updatedAt,
            priceE8: touch.priceE8,
            roundsScanned: scan.scanned,
          },
        };
      }
      const challengeEnd = p.endTime + TOUCH_CHALLENGE_SECONDS;
      if (now.timestamp >= challengeEnd) {
        if (!scan.complete)
          return { kind: "blocked", reason: scan.note ?? "The window could not be fully scanned." };
        return {
          kind: "evidence",
          method: "settle",
          evidence: EMPTY_EVIDENCE,
          value: 0n,
          detail: { roundsScanned: scan.scanned, challengeEnd },
        };
      }
      return {
        kind: "wait",
        reason: `No round has touched the strike yet (${scan.scanned} rounds checked). NO can settle from ${iso(challengeEnd)}, after the 24-hour challenge period.`,
        detail: { roundsScanned: scan.scanned },
      };
    }

    case "perpl-funding-spike": {
      const p = d.params;
      if (now.block <= p.startBlock + 1n)
        return { kind: "wait", reason: `The window opens after block ${p.startBlock}.` };
      const exchange = await resolverExchange(ctx, m.resolver);
      const scan = await scanSpikes(ctx, exchange, p, { head: now.block });
      const spike = scan.spikes[0];
      if (spike) {
        return {
          kind: "evidence",
          method: closed ? "settle" : "proveYes",
          evidence: encodeFundingEventEvidence(spike.eventBlock),
          value: 0n,
          detail: {
            eventBlock: spike.eventBlock,
            increment: spike.increment,
            threshold: p.threshold,
            eventsChecked: scan.events,
          },
        };
      }
      const challengeBlocks = await ctx.publicClient.readContract({
        address: m.resolver,
        abi: perplResolverAbi,
        functionName: "challengeBlocks",
      });
      const challengeEnd = p.endBlock + challengeBlocks;
      if (now.block > challengeEnd) {
        if (!scan.complete)
          return { kind: "blocked", reason: scan.note ?? "The window could not be fully scanned." };
        return {
          kind: "evidence",
          method: "settle",
          evidence: EMPTY_EVIDENCE,
          value: 0n,
          detail: { eventsChecked: scan.events, challengeEndBlock: challengeEnd },
        };
      }
      return {
        kind: "wait",
        reason: `No funding event has charged more than the threshold yet (${scan.events} events checked). NO can settle after block ${challengeEnd}.`,
        detail: { eventsChecked: scan.events },
      };
    }

    case "parlay": {
      const legs = d.params.legs;
      const results = await multicall(
        ctx,
        legs.map((leg) => ({ address: leg as Address, abi: marketAbi, functionName: "outcome" })),
      );
      const outcomes = results.map((r) => Number(ok<number>(r) ?? 0) as Outcome);
      const anyNo = outcomes.includes(Outcome.No);
      const allYes = outcomes.every((o) => o === Outcome.Yes);
      if (!anyNo && !allYes) {
        const open = legs.filter((_, i) => outcomes[i] !== Outcome.Yes);
        return {
          kind: "wait",
          reason: `Waiting for ${open.length} of ${legs.length} legs to settle.`,
          detail: { openLegs: open },
        };
      }
      return {
        kind: "evidence",
        method: "settle",
        evidence: EMPTY_EVIDENCE,
        value: 0n,
        detail: { legs, outcomes: outcomes.map((o) => OUTCOME_LABEL[o]) },
      };
    }

    case "snapshot": {
      // Template 7: empty evidence. With a snapshot stored, settle answers from it. Without one,
      // settle inside the window takes it first (the dry run below does the same read). After the
      // window with no snapshot, the market can never answer and voids at its deadline.
      const p = d.params;
      const stored = await storedSnapshot(ctx, m.resolver, m.params);
      const windowEnd = p.closeTime + BigInt(p.snapshotWindow);
      if (stored) {
        return {
          kind: "evidence",
          method: "settle",
          evidence: EMPTY_EVIDENCE,
          value: 0n,
          detail: {
            snapshot: "stored",
            value: stored.value,
            snapshotBlock: stored.blockNumber,
            snapshotTime: stored.timestamp,
          },
        };
      }
      const state = snapshotWindowState(p.closeTime, p.snapshotWindow, now.timestamp);
      if (state === "before") {
        return {
          kind: "wait",
          reason: `The snapshot window opens at ${iso(p.closeTime)} and closes at ${iso(windowEnd)}.`,
        };
      }
      if (state === "after") {
        return {
          kind: "blocked",
          reason: `Nobody took a snapshot between ${iso(p.closeTime)} and ${iso(windowEnd)}, so the market cannot answer. It voids at its deadline.`,
        };
      }
      return {
        kind: "evidence",
        method: "settle",
        evidence: EMPTY_EVIDENCE,
        value: 0n,
        detail: { snapshot: "taken by settle", windowEnds: windowEnd },
      };
    }

    default:
      return { kind: "blocked", reason: `The SDK does not know template ${m.templateId}'s evidence format.` };
  }
  return { kind: "blocked", reason: "No evidence found." };
}

/** True once the market's close has passed, in its own clock. */
export function isClosed(m: Pick<MarketInfo, "window">, now: ChainNow): boolean {
  return m.window.blockClock ? now.block >= m.window.close : now.timestamp >= m.window.close;
}

/**
 * What settling `market` takes right now: the evidence, the method (`settle`, or `proveYes` for a
 * touch proved before close), the MON to send (Pyth's fee), and the outcome and evidence hash the
 * resolver would store, from a dry run. Works for templates 1 to 7.
 */
export async function planSettlement(
  ctx: HunchContext,
  market: Address | MarketInfo,
  options: { now?: ChainNow } = {},
): Promise<SettlementPlan> {
  const m = await requireMarket(ctx, market);
  if (m.phase === Phase.Settled) {
    return {
      status: "final",
      reason: `Settled ${OUTCOME_LABEL[m.outcome].toUpperCase()}.`,
      outcome: m.outcome,
    };
  }
  if (m.phase === Phase.Voided) return { status: "final", reason: "Voided.", outcome: Outcome.Unresolved };
  const now = options.now ?? (await chainNow(ctx));
  if (now.timestamp > m.window.settleDeadline) {
    return {
      status: "expired",
      reason: `The settlement deadline (${iso(m.window.settleDeadline)}) has passed. Anyone can call voidIfExpired.`,
    };
  }
  const closed = isClosed(m, now);
  let found: Found;
  try {
    found = await findEvidence(ctx, m, now, closed);
  } catch (e) {
    return { status: "blocked", reason: `Could not read the source: ${describeError(e)}` };
  }
  if (found.kind !== "evidence") {
    return found.detail
      ? { status: found.kind, reason: found.reason, detail: found.detail }
      : { status: found.kind, reason: found.reason };
  }
  if (found.method === "settle" && !closed) {
    return { status: "wait", reason: "The market has not closed yet, so it cannot settle." };
  }
  if (found.method === "proveYes" && m.phase === Phase.Pool) {
    return { status: "wait", reason: "The pool is still open: a touch can be proved once it locks." };
  }
  try {
    const run = await dryRunResolve(ctx, m, found.evidence, found.value);
    if (run.outcome === Outcome.Unresolved) {
      return {
        status: "wait",
        reason:
          m.decoded.kind === "perpl-funding" || m.decoded.kind === "perpl-funding-spike"
            ? "The resolver cannot answer yet: Perpl's data is not final, or the perp or Perpl's contract changed during the window."
            : m.decoded.kind === "snapshot"
              ? "The source cannot be read right now, or failed one of the resolver's checks. Try again inside the snapshot window."
              : "The resolver cannot answer yet: the source has no final answer for this market.",
        detail: found.detail,
      };
    }
    return {
      status: "ready",
      method: found.method,
      evidence: found.evidence,
      value: found.value,
      outcome: run.outcome,
      outcomeLabel: OUTCOME_LABEL[run.outcome],
      evidenceHash: run.evidenceHash,
      detail: found.detail,
    };
  } catch (e) {
    return { status: "blocked", reason: describeError(e), detail: found.detail };
  }
}
