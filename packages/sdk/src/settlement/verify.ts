import {
  chainlinkEvidenceHash,
  EMPTY_EVIDENCE,
  encodeFundingEventEvidence,
  encodeRoundEvidence,
  marketAbi,
  Outcome,
  Phase,
  PriceSource,
  perplEvidenceHash,
  perplOutcome,
  priceToE8,
  snapshotEvidenceHash,
  snapshotOutcome,
  TOUCH_CHALLENGE_SECONDS,
} from "@hunch-book/shared";
import {
  type Address,
  BaseError,
  ContractFunctionZeroDataError,
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  type Hex,
  isAddressEqual,
} from "viem";
import type { HunchContext } from "../context.js";
import { describeError } from "../errors.js";
import { type MarketInfo, OUTCOME_LABEL, type OutcomeLabel, requireMarket } from "../markets.js";
import { multicall, ok } from "../multicall.js";
import { findBracket, latestRound, roundDecimals, scanTouches } from "./chainlink.js";
import { chainNow, dryRunResolve, planSettlement, type SettlementPlan } from "./evidence.js";
import { parlayHash, spikeNoHash, spikeYesHash, touchNoHash, touchYesHash } from "./hashes.js";
import { fundingAt, perplResolverAbi, resolverExchange, scanSpikes } from "./perpl.js";
import { pythFeeAbi, resolverPythAbi } from "./pyth.js";
import { rereadSource, snapshotSource, storedSnapshot } from "./snapshot.js";

// The settlement verifier: the reads a market's resolver made, done again with a plain public client;
// the evidence hash rebuilt from those values and compared with the one the market stored; and the
// resolver re-run as a call with the same evidence. Nobody has to trust the settler, the keeper or
// this SDK: every input is public chain data (docs/TEMPLATES.md lists each hash).

export interface SettlementTx {
  block: bigint;
  time: bigint;
  hash: Hex;
  /** The settler from the Settled event, or the sender of a void. */
  by: Address;
  kind: "settled" | "voided";
  /** The function the transaction called on the market, when it called the market directly. */
  method: "settle" | "proveYes" | "voidIfExpired" | null;
  /** The evidence the transaction passed, when it called the market directly. */
  evidence: Hex | null;
}

export interface Recomputed {
  outcome: OutcomeLabel | null;
  evidenceHash: Hex | null;
  /** The evidence that reproduces the read (and that the re-run used). */
  evidence: Hex | null;
  /** What was read, per template. */
  reads: Record<string, unknown>;
}

export interface Verification {
  market: Address;
  marketId: number;
  templateId: number;
  template: string;
  status: "settled" | "voided" | "open";
  stored: { outcome: OutcomeLabel; evidenceHash: Hex };
  recomputed: Recomputed;
  /** The resolver run again as a call with `recomputed.evidence`. */
  rerun: { outcome: OutcomeLabel; evidenceHash: Hex } | null;
  rerunError: string | null;
  matches: { evidenceHash: boolean | null; outcome: boolean | null; rerun: boolean | null };
  /** True when the stored hash is reproduced from the source; false on any mismatch; null when nothing could be checked. */
  verified: boolean | null;
  notes: string[];
  settlement: SettlementTx | null;
  /** For a market that has not settled: what settling now would do. */
  plan: SettlementPlan | null;
  checkedAt: { block: bigint; timestamp: bigint };
  rpc: string;
}

const SEARCH_PROBES = 4n;
/** Tries per historical read before the search gives up (public RPCs drop bursts of these). */
const READ_TRIES = 4;
const RETRY_BASE_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the call returned no data: the market had no code yet at that block. */
function isNoCode(e: unknown): boolean {
  return e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionZeroDataError) !== null;
}

/** True when the node does not have that block's state at all (not a hiccup worth retrying). */
function isStateUnavailable(e: unknown): boolean {
  return /resource not found|header not found|unknown block|missing trie node|state (is )?not available|pruned/i.test(
    String((e as { details?: string })?.details ?? "") + String((e as Error)?.message ?? ""),
  );
}

/**
 * Finds the transaction that settled or voided a market: searches `phase()` at past blocks for the
 * block where it became final, then reads that block's event and transaction. Needs an RPC that
 * serves past state. Pass `block` when it is already known (for example from the indexer).
 *
 * A block before the market existed, or one whose state the node does not keep, reads as "not final";
 * the event check at the end then makes sure the block found really settled the market. Any other
 * failed read (a public RPC dropping a burst of calls) is retried, and if it keeps failing the search
 * throws rather than guess.
 */
export async function findSettlementTx(
  ctx: HunchContext,
  market: Pick<MarketInfo, "address">,
  options: { block?: bigint; fromBlock?: bigint; head?: bigint; retryBaseMs?: number } = {},
): Promise<SettlementTx | null> {
  let block = options.block;
  if (block === undefined) {
    const head = options.head ?? (await ctx.publicClient.getBlockNumber());
    const retryBase = options.retryBaseMs ?? RETRY_BASE_MS;
    const finalAt = async (b: bigint): Promise<boolean> => {
      for (let attempt = 1; ; attempt++) {
        try {
          const phase = await ctx.publicClient.readContract({
            address: market.address,
            abi: marketAbi,
            functionName: "phase",
            blockNumber: b,
          });
          return phase === Phase.Settled || phase === Phase.Voided;
        } catch (e) {
          if (isNoCode(e) || isStateUnavailable(e)) return false;
          if (attempt >= READ_TRIES) throw e;
          await sleep(retryBase * 2 ** (attempt - 1));
        }
      }
    };
    if (!(await finalAt(head))) return null;
    const from = options.fromBlock ?? BigInt(ctx.deployment.hunchBook.deployBlock ?? 0);
    let lo = from > 0n ? from - 1n : 0n;
    let hi = head;
    if (await finalAt(lo)) return null;
    while (hi - lo > 1n) {
      const gap = hi - lo;
      const count = gap - 1n < SEARCH_PROBES ? gap - 1n : SEARCH_PROBES;
      const probes: bigint[] = [];
      for (let n = 1n; n <= count; n++) probes.push(lo + (gap * n) / (count + 1n));
      const unique = [...new Set(probes)];
      const final = await Promise.all(unique.map(finalAt));
      let nextLo = lo;
      let nextHi = hi;
      for (let i = 0; i < unique.length; i++) {
        const b = unique[i] as bigint;
        if (final[i]) {
          nextHi = b;
          break;
        }
        nextLo = b;
      }
      lo = nextLo;
      hi = nextHi;
    }
    block = hi;
  }
  const logs = await ctx.publicClient.getLogs({ address: market.address, fromBlock: block, toBlock: block });
  for (const log of logs) {
    let decoded: ReturnType<typeof decodeEventLog<typeof marketAbi>> | null = null;
    try {
      decoded = decodeEventLog({ abi: marketAbi, data: log.data, topics: log.topics });
    } catch {
      decoded = null;
    }
    if (!decoded || (decoded.eventName !== "Settled" && decoded.eventName !== "Voided")) continue;
    const hash = log.transactionHash as Hex;
    const [tx, blk] = await Promise.all([
      ctx.publicClient.getTransaction({ hash }),
      ctx.publicClient.getBlock({ blockNumber: block }),
    ]);
    let method: SettlementTx["method"] = null;
    let evidence: Hex | null = null;
    if (tx.to && isAddressEqual(tx.to, market.address)) {
      try {
        const call = decodeFunctionData({ abi: marketAbi, data: tx.input });
        if (call.functionName === "settle" || call.functionName === "proveYes") {
          method = call.functionName;
          evidence = call.args[0] as Hex;
        } else if (call.functionName === "voidIfExpired") {
          method = "voidIfExpired";
        }
      } catch {
        // not a direct market call
      }
    }
    return {
      block,
      time: blk.timestamp,
      hash,
      by: decoded.eventName === "Settled" ? (decoded.args as { settler: Address }).settler : tx.from,
      kind: decoded.eventName === "Settled" ? "settled" : "voided",
      method,
      evidence,
    };
  }
  return null;
}

const same = (a: Hex | null, b: Hex): boolean | null =>
  a === null ? null : a.toLowerCase() === b.toLowerCase();

interface TemplateCheck {
  recomputed: Recomputed;
  /** Whether a re-run is expected to reproduce the stored hash (false when the read depends on settle time). */
  rerunReproducesHash: boolean;
  value: bigint;
  notes: string[];
}

async function checkTemplate(
  ctx: HunchContext,
  m: MarketInfo,
  settlement: () => Promise<SettlementTx | null>,
): Promise<TemplateCheck> {
  const notes: string[] = [];
  const d = m.decoded;
  const blank = (reads: Record<string, unknown> = {}): Recomputed => ({
    outcome: null,
    evidenceHash: null,
    evidence: null,
    reads,
  });
  switch (d.kind) {
    case "perpl-funding": {
      const p = d.params;
      const exchange = await resolverExchange(ctx, m.resolver);
      const [start, end] = await fundingAt(ctx, exchange, p.perpId, [p.startBlock, p.endBlock]);
      if (!start || !end)
        return {
          recomputed: blank({ exchange }),
          rerunReproducesHash: true,
          value: 0n,
          notes: ["Perpl's funding history could not be read."],
        };
      const outcome = perplOutcome(start.sum, end.sum, p.threshold);
      return {
        recomputed: {
          outcome: OUTCOME_LABEL[outcome],
          evidenceHash: perplEvidenceHash({
            exchange,
            perpId: p.perpId,
            startBlock: p.startBlock,
            endBlock: p.endBlock,
            sumStart: start.sum,
            sumEnd: end.sum,
            eventStart: start.eventBlock,
            eventEnd: end.eventBlock,
          }),
          evidence: EMPTY_EVIDENCE,
          reads: {
            exchange,
            perpId: p.perpId,
            startBlock: p.startBlock,
            endBlock: p.endBlock,
            sumStart: start.sum,
            sumEnd: end.sum,
            eventStart: start.eventBlock,
            eventEnd: end.eventBlock,
            delta: end.sum - start.sum,
            threshold: p.threshold,
          },
        },
        rerunReproducesHash: true,
        value: 0n,
        notes,
      };
    }

    case "price-at-time":
    case "price-range": {
      const p = d.params;
      if (p.source === PriceSource.Pyth) {
        const tx = await settlement();
        if (!tx?.evidence) {
          return {
            recomputed: blank({ pythId: p.pythId }),
            rerunReproducesHash: true,
            value: 0n,
            notes: [
              "A Pyth settlement is checked by re-running the resolver with the update the settler sent, and that transaction was not found.",
            ],
          };
        }
        const pyth = await ctx.publicClient.readContract({
          address: m.resolver,
          abi: resolverPythAbi,
          functionName: "pyth",
        });
        const [updateData] = decodeAbiParameters([{ type: "bytes[]" }], tx.evidence);
        const fee = await ctx.publicClient.readContract({
          address: pyth,
          abi: pythFeeAbi,
          functionName: "getUpdateFee",
          args: [updateData],
        });
        notes.push(
          "Pyth: the stored hash is checked by re-running the resolver with the signed update from the settlement transaction.",
        );
        return {
          recomputed: { ...blank({ pythId: p.pythId, settlementTx: tx.hash }), evidence: tx.evidence },
          rerunReproducesHash: true,
          value: fee,
          notes,
        };
      }
      const b = await findBracket(ctx, p.feed, p.closeTime);
      if (b.status !== "found" && b.status !== "stale") {
        return {
          recomputed: blank({ feed: p.feed, bracket: b.status }),
          rerunReproducesHash: true,
          value: 0n,
          notes: ["No Chainlink round brackets the close."],
        };
      }
      const decimals = await roundDecimals(ctx, p.feed, b.round.roundId);
      const priceE8 = priceToE8(b.round.answer, -decimals);
      const yes =
        d.kind === "price-at-time"
          ? priceE8 >= d.params.strikeE8
          : priceE8 >= d.params.lowerE8 && priceE8 < d.params.upperE8;
      if (b.status === "stale")
        notes.push(
          "The bracketing round is more than an hour older than the close, so the resolver refuses it.",
        );
      return {
        recomputed: {
          outcome: b.status === "found" ? (yes ? "yes" : "no") : null,
          evidenceHash:
            b.status === "found"
              ? chainlinkEvidenceHash({
                  feed: p.feed,
                  roundId: b.round.roundId,
                  answer: b.round.answer,
                  updatedAt: b.round.updatedAt,
                  nextUpdatedAt: b.next.updatedAt,
                  target: p.closeTime,
                })
              : null,
          evidence: encodeRoundEvidence(b.round.roundId),
          reads: {
            feed: p.feed,
            target: p.closeTime,
            roundId: b.round.roundId,
            answer: b.round.answer,
            updatedAt: b.round.updatedAt,
            nextRoundId: b.next.roundId,
            nextUpdatedAt: b.next.updatedAt,
            decimals,
            priceE8,
            ...(d.kind === "price-at-time"
              ? { strikeE8: d.params.strikeE8 }
              : { lowerE8: d.params.lowerE8, upperE8: d.params.upperE8 }),
          },
        },
        rerunReproducesHash: true,
        value: 0n,
        notes,
      };
    }

    case "chainlink-touch": {
      const p = d.params;
      const scan = await scanTouches(ctx, p, { until: p.endTime, all: true });
      if (!scan.complete && scan.note) notes.push(scan.note);
      const reads: Record<string, unknown> = {
        feed: p.feed,
        roundsScanned: scan.scanned,
        touches: scan.touches.length,
      };
      if (m.outcome === Outcome.Yes || (m.phase !== Phase.Settled && scan.touches.length > 0)) {
        const hashes = scan.touches.map((t) => ({
          t,
          hash: touchYesHash({ feed: p.feed, roundId: t.roundId, updatedAt: t.updatedAt, answer: t.answer }),
        }));
        const match = hashes.find((h) => h.hash.toLowerCase() === m.evidenceHash.toLowerCase()) ?? hashes[0];
        if (!match)
          return {
            recomputed: { ...blank(reads), outcome: "no" },
            rerunReproducesHash: true,
            value: 0n,
            notes: [...notes, "No round in the window touched the strike."],
          };
        return {
          recomputed: {
            outcome: "yes",
            evidenceHash: match.hash,
            evidence: encodeRoundEvidence(match.t.roundId),
            reads: {
              ...reads,
              roundId: match.t.roundId,
              answer: match.t.answer,
              updatedAt: match.t.updatedAt,
              priceE8: match.t.priceE8,
              strikeE8: p.strikeE8,
            },
          },
          rerunReproducesHash: true,
          value: 0n,
          notes,
        };
      }
      // NO: the hash names the feed's latest round when NO was settled, so it is read at that block.
      const challengeEnd = p.endTime + TOUCH_CHALLENGE_SECONDS;
      if (scan.touches.length > 0) {
        notes.push(
          "A round in the window touched the strike, but nobody proved it during the challenge period.",
        );
      }
      const tx = await settlement();
      const candidates: { roundId: bigint; updatedAt: bigint; hash: Hex }[] = [];
      if (tx) {
        for (const blockNumber of [tx.block, tx.block - 1n]) {
          try {
            const latest = await latestRound(ctx, p.feed, { blockNumber });
            candidates.push({
              roundId: latest.roundId,
              updatedAt: latest.updatedAt,
              hash: touchNoHash({
                feed: p.feed,
                endTime: p.endTime,
                challengeEnd,
                latestRoundId: latest.roundId,
                latestUpdatedAt: latest.updatedAt,
              }),
            });
          } catch {
            // the RPC has no state that far back
          }
        }
      } else {
        notes.push(
          "The NO hash names the feed's latest round at settlement; the settlement block was not found, so it could not be rebuilt.",
        );
      }
      const match =
        candidates.find((c) => c.hash.toLowerCase() === m.evidenceHash.toLowerCase()) ?? candidates[0];
      notes.push(
        "A NO touch market's re-run reads the feed's latest round now, so only its outcome is compared.",
      );
      return {
        recomputed: {
          outcome: scan.touches.length > 0 ? "yes" : "no",
          evidenceHash: match?.hash ?? null,
          evidence: EMPTY_EVIDENCE,
          reads: {
            ...reads,
            challengeEnd,
            latestRoundId: match?.roundId ?? null,
            latestUpdatedAt: match?.updatedAt ?? null,
          },
        },
        rerunReproducesHash: false,
        value: 0n,
        notes,
      };
    }

    case "perpl-funding-spike": {
      const p = d.params;
      const exchange = await resolverExchange(ctx, m.resolver);
      const scan = await scanSpikes(ctx, exchange, p, { head: p.endBlock + 1n, all: true });
      if (!scan.complete && scan.note) notes.push(scan.note);
      const reads: Record<string, unknown> = {
        exchange,
        perpId: p.perpId,
        eventsChecked: scan.events,
        spikes: scan.spikes.length,
        threshold: p.threshold,
      };
      if (m.outcome === Outcome.Yes || (m.phase !== Phase.Settled && scan.spikes.length > 0)) {
        const hashes = scan.spikes.map((s) => ({
          s,
          hash: spikeYesHash({
            exchange,
            perpId: p.perpId,
            eventBlock: s.eventBlock,
            sum: s.sum,
            previousEventBlock: s.previousEventBlock,
            previousSum: s.previousSum,
          }),
        }));
        const match = hashes.find((h) => h.hash.toLowerCase() === m.evidenceHash.toLowerCase()) ?? hashes[0];
        if (!match)
          return {
            recomputed: { ...blank(reads), outcome: "no" },
            rerunReproducesHash: true,
            value: 0n,
            notes: [...notes, "No funding event in the window charged more than the threshold."],
          };
        return {
          recomputed: {
            outcome: "yes",
            evidenceHash: match.hash,
            evidence: encodeFundingEventEvidence(match.s.eventBlock),
            reads: {
              ...reads,
              eventBlock: match.s.eventBlock,
              increment: match.s.increment,
              previousEventBlock: match.s.previousEventBlock,
            },
          },
          rerunReproducesHash: true,
          value: 0n,
          notes,
        };
      }
      if (scan.spikes.length > 0)
        notes.push(
          "A funding event in the window was a spike, but nobody proved it during the challenge period.",
        );
      const challengeBlocks = await ctx.publicClient.readContract({
        address: m.resolver,
        abi: perplResolverAbi,
        functionName: "challengeBlocks",
      });
      const [end] = await fundingAt(ctx, exchange, p.perpId, [p.endBlock]);
      if (!end)
        return {
          recomputed: blank(reads),
          rerunReproducesHash: true,
          value: 0n,
          notes: [...notes, "Perpl's funding history could not be read."],
        };
      return {
        recomputed: {
          outcome: scan.spikes.length > 0 ? "yes" : "no",
          evidenceHash: spikeNoHash({
            exchange,
            perpId: p.perpId,
            endBlock: p.endBlock,
            challengeEndBlock: p.endBlock + challengeBlocks,
            lastEventBlock: end.eventBlock,
            lastSum: end.sum,
          }),
          evidence: EMPTY_EVIDENCE,
          reads: {
            ...reads,
            challengeEndBlock: p.endBlock + challengeBlocks,
            lastEventBlock: end.eventBlock,
            lastSum: end.sum,
          },
        },
        rerunReproducesHash: true,
        value: 0n,
        notes,
      };
    }

    case "parlay": {
      const legs = d.params.legs;
      const results = await multicall(
        ctx,
        legs.flatMap((leg) => [
          { address: leg as Address, abi: marketAbi, functionName: "outcome" },
          { address: leg as Address, abi: marketAbi, functionName: "evidenceHash" },
        ]),
      );
      const outcomes = legs.map((_, i) => Number(ok<number>(results[2 * i]) ?? 0));
      const hashes = legs.map((_, i) => ok<Hex>(results[2 * i + 1]) ?? (`0x${"00".repeat(32)}` as Hex));
      const anyNo = outcomes.includes(Outcome.No);
      const allYes = outcomes.every((o) => o === Outcome.Yes);
      const outcome = anyNo ? Outcome.No : allYes ? Outcome.Yes : Outcome.Unresolved;
      return {
        recomputed: {
          outcome: outcome === Outcome.Unresolved ? null : OUTCOME_LABEL[outcome],
          evidenceHash: outcome === Outcome.Unresolved ? null : parlayHash({ legs, outcomes, hashes }),
          evidence: EMPTY_EVIDENCE,
          reads: {
            legs,
            outcomes: outcomes.map((o) => OUTCOME_LABEL[o as Outcome]),
            legEvidenceHashes: hashes,
          },
        },
        rerunReproducesHash: true,
        value: 0n,
        notes,
      };
    }

    case "snapshot": {
      // Template 7: the market answers from the stored snapshot. Its hash commits to the call, the word
      // read, the value and the snapshot's block and time. The source call is also made again at that
      // block, as an independent read of the value.
      const p = d.params;
      const [source, stored] = await Promise.all([
        snapshotSource(ctx, m.resolver, p.sourceId),
        storedSnapshot(ctx, m.resolver, m.params),
      ]);
      const reads: Record<string, unknown> = {
        sourceId: p.sourceId,
        source: source.label,
        unit: source.unit,
        decimals: source.decimals,
        target: source.target,
        callData: source.callData,
        valueWord: source.valueWord,
        threshold: p.threshold,
        comparator: p.comparator,
      };
      if (!stored) {
        return {
          recomputed: blank(reads),
          rerunReproducesHash: true,
          value: 0n,
          notes: ["The resolver holds no snapshot for this market."],
        };
      }
      const reread = await rereadSource(ctx, source, stored.blockNumber);
      if (reread === null) {
        notes.push(
          "The source call could not be made again at the snapshot's block (the RPC may not keep that state).",
        );
      } else if (reread !== stored.value) {
        notes.push(
          "The source read again at the end of the snapshot's block differs from the snapshot: a later transaction in that block moved it. The snapshot transaction's trace shows the exact read.",
        );
      }
      return {
        recomputed: {
          outcome: OUTCOME_LABEL[snapshotOutcome(stored.value, p.threshold, p.comparator)],
          evidenceHash: snapshotEvidenceHash({
            target: source.target,
            callData: source.callData,
            valueWord: source.valueWord,
            value: stored.value,
            blockNumber: stored.blockNumber,
            timestamp: stored.timestamp,
          }),
          evidence: EMPTY_EVIDENCE,
          reads: {
            ...reads,
            snapshotKey: stored.key,
            value: stored.value,
            snapshotBlock: stored.blockNumber,
            snapshotTime: stored.timestamp,
            rereadValue: reread,
            rereadMatches: reread === null ? null : reread === stored.value,
          },
        },
        rerunReproducesHash: true,
        value: 0n,
        notes,
      };
    }

    default:
      return {
        recomputed: blank(),
        rerunReproducesHash: false,
        value: 0n,
        notes: [`The SDK does not know template ${m.templateId}.`],
      };
  }
}

/**
 * Verifies a market's settlement from the chain alone: rebuilds the evidence hash from the source,
 * compares it and the outcome with what the market stored, and re-runs the resolver. For a market
 * that has not settled, returns what settling now would do (`plan`).
 */
export async function verifySettlement(
  ctx: HunchContext,
  market: Address | MarketInfo,
  options: { settlementBlock?: bigint } = {},
): Promise<Verification> {
  const m = await requireMarket(ctx, market);
  const now = await chainNow(ctx);
  const status = m.phase === Phase.Settled ? "settled" : m.phase === Phase.Voided ? "voided" : "open";
  const base = {
    market: m.address,
    marketId: m.id,
    templateId: m.templateId,
    template: m.template,
    status,
    stored: { outcome: OUTCOME_LABEL[m.outcome], evidenceHash: m.evidenceHash },
    checkedAt: { block: now.block, timestamp: now.timestamp },
    rpc: ctx.deployment.rpc,
  } as const;

  if (status !== "settled") {
    const notes =
      status === "voided"
        ? ["A voided market stores no evidence: it voids only after its deadline passes with no answer."]
        : ["Not settled yet. `plan` shows what settling now would store."];
    const settlement =
      status === "voided"
        ? await findSettlementTx(ctx, m, { block: options.settlementBlock }).catch(() => null)
        : null;
    return {
      ...base,
      recomputed: { outcome: null, evidenceHash: null, evidence: null, reads: {} },
      rerun: null,
      rerunError: null,
      matches: { evidenceHash: null, outcome: null, rerun: null },
      verified: null,
      notes,
      settlement,
      plan: status === "open" ? await planSettlement(ctx, m, { now }) : null,
    };
  }

  let cached: Promise<SettlementTx | null> | undefined;
  const settlement = (): Promise<SettlementTx | null> => {
    cached ??= findSettlementTx(ctx, m, { block: options.settlementBlock, head: now.block }).catch(
      () => null,
    );
    return cached;
  };
  let check: TemplateCheck;
  try {
    check = await checkTemplate(ctx, m, settlement);
  } catch (e) {
    check = {
      recomputed: { outcome: null, evidenceHash: null, evidence: null, reads: {} },
      rerunReproducesHash: false,
      value: 0n,
      notes: [`Could not read the source: ${describeError(e)}`],
    };
  }
  let rerun: Verification["rerun"] = null;
  let rerunError: string | null = null;
  if (check.recomputed.evidence !== null) {
    try {
      const run = await dryRunResolve(ctx, m, check.recomputed.evidence, check.value);
      rerun = { outcome: OUTCOME_LABEL[run.outcome], evidenceHash: run.evidenceHash };
      if (run.outcome === Outcome.Unresolved) {
        check.notes.push(
          "The resolver cannot answer today (for example, the source changed since settlement).",
        );
      }
    } catch (e) {
      rerunError = describeError(e);
    }
  }
  const storedOutcome = OUTCOME_LABEL[m.outcome];
  const hashMatch = same(check.recomputed.evidenceHash, m.evidenceHash);
  const outcomeMatch = check.recomputed.outcome === null ? null : check.recomputed.outcome === storedOutcome;
  const rerunMatch =
    rerun === null || rerun.outcome === "unresolved"
      ? null
      : rerun.outcome === storedOutcome &&
        (!check.rerunReproducesHash || rerun.evidenceHash.toLowerCase() === m.evidenceHash.toLowerCase());
  const checks = [hashMatch, rerunMatch].filter((v): v is boolean => v !== null);
  const verified = checks.length === 0 ? null : checks.every(Boolean);
  const tx = cached ? await cached : null;
  return {
    ...base,
    recomputed: check.recomputed,
    rerun,
    rerunError,
    matches: { evidenceHash: hashMatch, outcome: outcomeMatch, rerun: rerunMatch },
    verified,
    notes: check.notes,
    settlement: tx,
    plan: null,
  };
}
