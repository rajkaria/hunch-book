import {
  type BracketResult,
  type ChainlinkRound,
  chainlinkAggregatorAbi,
  chainlinkEvidence,
  chainlinkLatestRoundAbi,
  EMPTY_EVIDENCE,
  findBracketingRound,
  Outcome,
  PERPL_EVIDENCE,
  PriceSource,
  type RoundReader,
  resolverAbi,
  snapshotWindowState,
} from "@hunch-book/shared";
import type { Abi, Address, Hex, PublicClient } from "viem";
import { MULTICALL3 } from "../chain/client";
import { formatDuration, formatInt, formatUtc } from "../format";
import { readSnapshotFor } from "../snapshot";
import { describeTxError, withKnownErrors } from "../wallet/errors";
import type { MarketView } from "./types";

// The evidence a `settle` call needs, found from the browser, and a dry run of the resolver with it.
// Perpl funding markets settle with empty evidence. Chainlink price markets settle with the one round
// that brackets the close, found by walking the feed's rounds. Pyth markets need a signed update from
// Pyth's Hermes service, which needs an API key, so the keeper settles those.

export type PlanClient = Pick<PublicClient, "readContract" | "multicall" | "simulateContract">;

export type SettlePlan =
  /** The resolver answers with this evidence: settling now gives `outcome`. */
  | {
      status: "ready";
      evidence: Hex;
      outcome: Outcome;
      evidenceHash: Hex;
      bracket: BracketResult | null;
      /** Anything else settling now does, in one sentence (template 7: it takes the snapshot). */
      note?: string;
    }
  /** The resolver returns Unresolved: the source has no final answer yet. */
  | { status: "unresolved"; reason: string }
  /** No evidence can settle it from here, and why. */
  | { status: "blocked"; reason: string };

/** getRoundData for several rounds in one multicall. A round that reverts, echoes another id or is empty reads as null. */
export function chainlinkRoundReader(client: Pick<PublicClient, "multicall">, feed: Address): RoundReader {
  return async (ids) => {
    const results = await client.multicall({
      contracts: ids.map((id) => ({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: "getRoundData" as const,
        args: [id] as const,
      })),
      allowFailure: true,
      multicallAddress: MULTICALL3,
    });
    return results.map((r, i) => {
      if (r.status !== "success") return null;
      const [roundId, answer, , updatedAt] = r.result;
      if (roundId !== ids[i] || updatedAt === 0n) return null;
      return { roundId, answer, updatedAt };
    });
  };
}

export async function readLatestRound(
  client: Pick<PublicClient, "readContract">,
  feed: Address,
): Promise<ChainlinkRound> {
  const [roundId, answer, , updatedAt] = await client.readContract({
    address: feed,
    abi: chainlinkLatestRoundAbi,
    functionName: "latestRoundData",
  });
  return { roundId, answer, updatedAt };
}

/** The round a Chainlink market settles with, found from the feed's latest round. */
export async function findChainlinkBracket(
  client: Pick<PublicClient, "readContract" | "multicall">,
  feed: Address,
  target: bigint,
): Promise<BracketResult> {
  const latest = await readLatestRound(client, feed);
  return findBracketingRound({ latest, target, read: chainlinkRoundReader(client, feed) });
}

/** Plain words for a bracket that cannot settle the market. */
export function bracketProblem(bracket: BracketResult): string | null {
  switch (bracket.status) {
    case "found":
      return null;
    case "waiting":
      return `Waiting for Chainlink's first round after the close. The feed last updated at ${formatUtc(bracket.latest.updatedAt)}.`;
    case "stale":
      return `Chainlink's last round before the close is ${formatDuration(bracket.staleSeconds)} older than the close, more than the one hour the resolver accepts. The market voids at its deadline.`;
    case "phase-start":
      return "Chainlink's feed moved to a new phase after the close, so no round in it brackets the close. The market voids at its deadline.";
  }
}

/**
 * Runs the market's resolver with `evidence` as a call (no transaction, no wallet), from the market's
 * own address as `settle` would. Returns the outcome and evidence hash it would store.
 */
export async function dryRunResolve(
  client: Pick<PublicClient, "simulateContract">,
  m: Pick<MarketView, "address" | "resolver" | "params">,
  evidence: Hex,
): Promise<{ outcome: Outcome; evidenceHash: Hex }> {
  const { result } = await client.simulateContract({
    address: m.resolver,
    abi: withKnownErrors(resolverAbi as Abi),
    functionName: "resolve",
    args: [m.params, evidence],
    account: m.address,
  });
  const [outcome, evidenceHash] = result as readonly [number, Hex];
  return { outcome: Number(outcome) as Outcome, evidenceHash };
}

/** Finds the evidence for `settle` and dry-runs the resolver with it. */
export async function planSettlement(client: PlanClient, m: MarketView): Promise<SettlePlan> {
  let evidence: Hex;
  let bracket: BracketResult | null = null;
  if (m.decoded.kind === "perpl-funding") {
    evidence = PERPL_EVIDENCE;
  } else if (m.decoded.kind === "price-at-time" && m.decoded.params.source === PriceSource.Chainlink) {
    try {
      bracket = await findChainlinkBracket(client, m.decoded.params.feed, m.decoded.params.closeTime);
    } catch (e) {
      return { status: "blocked", reason: `Could not read the Chainlink feed: ${describeTxError(e)}` };
    }
    const problem = bracketProblem(bracket);
    if (problem || bracket.status !== "found")
      return { status: "blocked", reason: problem ?? "No round found." };
    evidence = chainlinkEvidence(bracket.round.roundId);
  } else if (m.decoded.kind === "snapshot") {
    // Template 7 settles with empty evidence; inside the window `settle` takes the snapshot itself.
    evidence = EMPTY_EVIDENCE;
  } else if (m.decoded.kind === "price-at-time") {
    return {
      status: "blocked",
      reason:
        "Settling needs a signed Pyth price update, which this app cannot fetch without a Pyth API key. The keeper settles these.",
    };
  } else {
    return { status: "blocked", reason: "This app does not know this template's evidence format." };
  }

  if (m.decoded.kind === "snapshot") return planSnapshot(client, m, m.decoded.params);

  try {
    const run = await dryRunResolve(client, m, evidence);
    if (run.outcome === Outcome.Unresolved) {
      return {
        status: "unresolved",
        reason:
          m.decoded.kind === "perpl-funding"
            ? "Not resolvable yet: Perpl's funding for the window is not final, or the perp or Perpl's contract changed during the window."
            : "Not resolvable yet: the source has no final answer for this market.",
      };
    }
    return { status: "ready", evidence, outcome: run.outcome, evidenceHash: run.evidenceHash, bracket };
  } catch (e) {
    return { status: "blocked", reason: describeTxError(e) };
  }
}

/**
 * Template 7: `settle()` with empty evidence answers from the stored snapshot, or inside the window
 * takes the snapshot first. Says which, and why it cannot answer outside those cases.
 */
async function planSnapshot(
  client: PlanClient,
  m: MarketView,
  p: { closeTime: bigint; snapshotWindow: number },
): Promise<SettlePlan> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const window = snapshotWindowState(p.closeTime, p.snapshotWindow, now);
  const end = formatUtc(p.closeTime + BigInt(p.snapshotWindow));
  try {
    const [{ snapshot }, run] = await Promise.all([
      readSnapshotFor(client, m.resolver, m.params),
      dryRunResolve(client, m, EMPTY_EVIDENCE),
    ]);
    if (run.outcome === Outcome.Unresolved) {
      return {
        status: "unresolved",
        reason:
          window === "after"
            ? "Nobody took a snapshot in its window, so this market has no answer. It voids at its deadline."
            : window === "before"
              ? `The snapshot window opens at ${formatUtc(p.closeTime)}.`
              : `The source cannot be read right now, or it no longer means what it did when the resolver was deployed (for Perpl: an upgrade, a pause or a relisting). Anyone can try again until ${end}.`,
      };
    }
    return {
      status: "ready",
      evidence: EMPTY_EVIDENCE,
      outcome: run.outcome,
      evidenceHash: run.evidenceHash,
      bracket: null,
      note: snapshot
        ? `It answers from the snapshot taken at block ${formatInt(snapshot.blockNumber)}.`
        : `Settling now takes the snapshot and settles in one transaction. The window closes at ${end}.`,
    };
  } catch (e) {
    return { status: "blocked", reason: describeTxError(e) };
  }
}
