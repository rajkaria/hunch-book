import {
  type BracketResult,
  chainlinkAggregatorAbi,
  chainlinkEvidence,
  chainlinkEvidenceHash,
  chainlinkOutcome,
  chainlinkPhase,
  type Deployment,
  EMPTY_EVIDENCE,
  marketAbi,
  type Outcome,
  PERPL_EVIDENCE,
  Phase,
  PriceSource,
  perplEvidenceHash,
  perplExchangeAbi,
  perplOutcome,
  priceToE8,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  decodeEventLog,
  decodeFunctionData,
  type Hex,
  isAddressEqual,
  type PublicClient,
  parseAbi,
} from "viem";
import { MULTICALL3 } from "../chain/client";
import { dryRunResolve, findChainlinkBracket } from "../market/settle";
import type { MarketView } from "../market/types";
import { checkSnapshot, type SnapshotCheck } from "../snapshot";
import { describeTxError } from "../wallet/errors";

// The settlement verifier (roadmap A-4): the exact reads a market's resolver makes, done again from the
// browser with a plain public client, the evidence hash rebuilt from those values, and the resolver
// itself re-run as a call. Each is compared with what the market stored when it settled. For a market
// that has not settled, the same reads show what the source says now.

/** PerplFundingResolver views that the IResolver interface leaves out. */
export const perplResolverAbi = parseAbi([
  "function exchange() view returns (address)",
  "function versionUnchanged() view returns (bool)",
]);

export type VerifyClient = Pick<
  PublicClient,
  "readContract" | "multicall" | "simulateContract" | "getLogs" | "getTransaction" | "getBlock" | "call"
>;

export interface ResolverRun {
  outcome: Outcome;
  evidenceHash: Hex;
}

export interface PerplRead {
  template: "perpl";
  exchange: Address;
  perpId: bigint;
  symbol: string | null;
  priceDecimals: number | null;
  scalingExp: number | null;
  expectedScalingExp: number;
  threshold: bigint;
  startBlock: bigint;
  endBlock: bigint;
  /** The block read for the end of the window: endBlock once final, the chain head before that. */
  endRead: bigint;
  /** True once block.number > endBlock: every funding event in the window is final. */
  final: boolean;
  /** False before the window starts: nothing to read yet. */
  started: boolean;
  start: { sum: bigint; eventBlock: bigint } | null;
  end: { sum: bigint; eventBlock: bigint } | null;
  delta: bigint | null;
  interval: bigint | null;
  versionUnchanged: boolean | null;
  outcome: Outcome | null;
  expectedHash: Hex | null;
}

export interface ChainlinkRead {
  template: "chainlink";
  feed: Address;
  target: bigint;
  strikeE8: bigint;
  bracket: BracketResult | null;
  bracketError: string | null;
  decimals: number | null;
  priceE8: bigint | null;
  outcome: Outcome | null;
  expectedHash: Hex | null;
}

export interface OtherRead {
  template: "pyth" | "unknown";
}

export type SourceRead = PerplRead | ChainlinkRead | SnapshotCheck | OtherRead;

/** The reads this page can rebuild an outcome and an evidence hash from. */
export type CheckedRead = PerplRead | ChainlinkRead | SnapshotCheck;

export const isCheckedRead = (read: SourceRead): read is CheckedRead =>
  read.template === "perpl" || read.template === "chainlink" || read.template === "snapshot";

export interface Verification {
  /** "settled": compare with what the market stored. "preview": what the read says now. */
  mode: "settled" | "voided" | "preview";
  read: SourceRead;
  /** The resolver run as a call with the same evidence, or why it could not run. */
  rerun: ResolverRun | null;
  rerunError: string | null;
  /** Null when there is nothing stored to compare (preview, void). */
  matches: { outcome: boolean | null; hash: boolean | null; resolver: boolean | null } | null;
  rpc: string;
  ranAt: number;
  headBlock: bigint;
}

const int = (v: unknown): bigint => BigInt(v as bigint | number);

async function readPerpl(
  client: VerifyClient,
  deployment: Deployment,
  m: MarketView,
  head: bigint,
): Promise<PerplRead> {
  if (m.decoded.kind !== "perpl-funding") throw new Error("not a Perpl market");
  const p = m.decoded.params;
  let exchange = deployment.external.perpl.exchange;
  try {
    exchange = await client.readContract({
      address: m.resolver,
      abi: perplResolverAbi,
      functionName: "exchange",
    });
  } catch {
    // Older resolvers without the getter: deployments lists the same exchange.
  }
  const started = head > p.startBlock;
  const final = head > p.endBlock;
  const endRead = final ? p.endBlock : head;
  const base: PerplRead = {
    template: "perpl",
    exchange,
    perpId: p.perpId,
    symbol: null,
    priceDecimals: null,
    scalingExp: null,
    expectedScalingExp: p.expectedScalingExp,
    threshold: p.threshold,
    startBlock: p.startBlock,
    endBlock: p.endBlock,
    endRead,
    final,
    started,
    start: null,
    end: null,
    delta: null,
    interval: null,
    versionUnchanged: null,
    outcome: null,
    expectedHash: null,
  };
  const calls = [
    { address: exchange, abi: perplExchangeAbi as Abi, functionName: "getPerpetualInfoV2", args: [p.perpId] },
    { address: exchange, abi: perplExchangeAbi as Abi, functionName: "getFundingInterval" },
    { address: m.resolver, abi: perplResolverAbi as Abi, functionName: "versionUnchanged" },
    ...(started
      ? [
          {
            address: exchange,
            abi: perplExchangeAbi as Abi,
            functionName: "getFundingSumAtBlock",
            args: [p.perpId, p.startBlock],
          },
          {
            address: exchange,
            abi: perplExchangeAbi as Abi,
            functionName: "getFundingSumAtBlock",
            args: [p.perpId, endRead],
          },
        ]
      : []),
  ];
  const results = (await client.multicall({
    contracts: calls as never,
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })) as ({ status: "success"; result: unknown } | { status: "failure"; error: Error })[];
  const ok = <T>(i: number): T | undefined => {
    const r = results[i];
    return r?.status === "success" ? (r.result as T) : undefined;
  };
  const info = ok<{ symbol: string; priceDecimals: bigint; fundingSumScalingExp: bigint }>(0);
  const interval = ok<bigint>(1);
  const versionUnchanged = ok<boolean>(2);
  const startSum = started ? ok<readonly [number | bigint, bigint]>(3) : undefined;
  const endSum = started ? ok<readonly [number | bigint, bigint]>(4) : undefined;
  const start = startSum ? { sum: int(startSum[0]), eventBlock: int(startSum[1]) } : null;
  const end = endSum ? { sum: int(endSum[0]), eventBlock: int(endSum[1]) } : null;
  const delta = start && end ? end.sum - start.sum : null;
  return {
    ...base,
    symbol: info?.symbol ?? null,
    priceDecimals: info ? Number(info.priceDecimals) : null,
    scalingExp: info ? Number(info.fundingSumScalingExp) : null,
    interval: interval ?? null,
    versionUnchanged: versionUnchanged ?? null,
    start,
    end,
    delta,
    outcome: start && end ? perplOutcome(start.sum, end.sum, p.threshold) : null,
    expectedHash:
      final && start && end
        ? perplEvidenceHash({
            exchange,
            perpId: p.perpId,
            startBlock: p.startBlock,
            endBlock: p.endBlock,
            sumStart: start.sum,
            sumEnd: end.sum,
            eventStart: start.eventBlock,
            eventEnd: end.eventBlock,
          })
        : null,
  };
}

async function readChainlink(client: VerifyClient, m: MarketView): Promise<ChainlinkRead> {
  if (m.decoded.kind !== "price-at-time") throw new Error("not a price market");
  const p = m.decoded.params;
  const base: ChainlinkRead = {
    template: "chainlink",
    feed: p.feed,
    target: p.closeTime,
    strikeE8: p.strikeE8,
    bracket: null,
    bracketError: null,
    decimals: null,
    priceE8: null,
    outcome: null,
    expectedHash: null,
  };
  let bracket: BracketResult;
  try {
    bracket = await findChainlinkBracket(client, p.feed, p.closeTime);
  } catch (e) {
    return { ...base, bracketError: describeTxError(e) };
  }
  if (bracket.status !== "found" && bracket.status !== "stale") return { ...base, bracket };
  // A round is scaled with the decimals of the aggregator that wrote it (PriceAtTimeResolver._roundDecimals).
  const aggregator = await client.readContract({
    address: p.feed,
    abi: chainlinkAggregatorAbi,
    functionName: "phaseAggregators",
    args: [Number(chainlinkPhase(bracket.round.roundId))],
  });
  const decimals = Number(
    await client.readContract({ address: aggregator, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
  );
  return {
    ...base,
    bracket,
    decimals,
    priceE8: priceToE8(bracket.round.answer, -decimals),
    outcome: chainlinkOutcome(bracket.round.answer, decimals, p.strikeE8),
    expectedHash:
      bracket.status === "found"
        ? chainlinkEvidenceHash({
            feed: p.feed,
            roundId: bracket.round.roundId,
            answer: bracket.round.answer,
            updatedAt: bracket.round.updatedAt,
            nextUpdatedAt: bracket.next.updatedAt,
            target: p.closeTime,
          })
        : null,
  };
}

/**
 * The evidence to re-run the resolver with, or null when there is none. A stale Chainlink bracket is
 * still passed, so the resolver itself shows that it refuses the round.
 */
export function evidenceFor(read: SourceRead): Hex | null {
  if (read.template === "perpl") return read.final ? PERPL_EVIDENCE : null;
  // Template 7 always settles with empty evidence: from the stored snapshot, or inside the window by
  // taking it (the re-run is a call, so nothing is stored).
  if (read.template === "snapshot") return read.snapshot || read.window === "open" ? EMPTY_EVIDENCE : null;
  if (read.template === "chainlink") {
    const b = read.bracket;
    return b?.status === "found" || b?.status === "stale" ? chainlinkEvidence(b.round.roundId) : null;
  }
  return null;
}

/** Runs every read, rebuilds the evidence hash, re-runs the resolver, and compares with the stored values. */
export async function runVerification(
  client: VerifyClient,
  deployment: Deployment,
  m: MarketView,
  head: bigint,
): Promise<Verification> {
  let read: SourceRead;
  if (m.decoded.kind === "perpl-funding") read = await readPerpl(client, deployment, m, head);
  else if (m.decoded.kind === "price-at-time" && m.decoded.params.source === PriceSource.Chainlink) {
    read = await readChainlink(client, m);
  } else if (m.decoded.kind === "snapshot") {
    const block = await client.getBlock({ blockNumber: head });
    read = await checkSnapshot(client, m.resolver, m.params, m.decoded.params, block.timestamp);
  } else read = { template: m.decoded.kind === "price-at-time" ? "pyth" : "unknown" };

  const mode = m.phase === Phase.Settled ? "settled" : m.phase === Phase.Voided ? "voided" : "preview";
  let rerun: ResolverRun | null = null;
  let rerunError: string | null = null;
  const evidence = evidenceFor(read);
  if (evidence !== null) {
    try {
      rerun = await dryRunResolve(client, m, evidence);
    } catch (e) {
      rerunError = describeTxError(e);
    }
  }

  const expectedHash = isCheckedRead(read) ? read.expectedHash : null;
  const outcome = isCheckedRead(read) ? read.outcome : null;
  const matches =
    mode === "settled"
      ? {
          outcome: outcome === null ? null : outcome === m.outcome,
          hash: expectedHash === null ? null : expectedHash.toLowerCase() === m.evidenceHash.toLowerCase(),
          resolver:
            rerun === null
              ? null
              : rerun.outcome === m.outcome &&
                rerun.evidenceHash.toLowerCase() === m.evidenceHash.toLowerCase(),
        }
      : null;
  return {
    mode,
    read,
    rerun,
    rerunError,
    matches,
    rpc: deployment.rpc,
    ranAt: Date.now(),
    headBlock: head,
  };
}

// ---------------------------------------------------------------- the settlement transaction

export interface SettlementTx {
  block: bigint;
  time: number;
  hash: Hex;
  /** The settler from the Settled event, or the sender for a void. */
  by: Address;
  kind: "settled" | "voided";
  /** The evidence passed to `settle`, when the transaction called the market directly. */
  evidence: Hex | null;
}

/** Probes per round of the block search, sent as one batch. */
const SEARCH_PROBES = 8n;

const isFinalPhase = (phase: number): boolean => phase === Phase.Settled || phase === Phase.Voided;

/**
 * Finds the block where the market settled or voided by searching its `phase()` at past blocks, then
 * reads that block's event and transaction. No indexer needed; it needs an RPC that serves past state.
 */
export async function findSettlementTx(
  client: VerifyClient,
  m: Pick<MarketView, "address" | "window">,
  from: bigint,
  head: bigint,
): Promise<SettlementTx | null> {
  const finalAt = async (block: bigint): Promise<boolean> => {
    try {
      const phase = await client.readContract({
        address: m.address,
        abi: marketAbi,
        functionName: "phase",
        blockNumber: block,
      });
      return isFinalPhase(Number(phase));
    } catch {
      return false; // not created yet, or the RPC has no state that far back
    }
  };
  if (!(await finalAt(head))) return null;
  let lo = from > 0n ? from - 1n : 0n; // not final at lo (assumed), final at hi
  let hi = head;
  if (await finalAt(lo)) return null; // cannot tell where it happened
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
  const block = hi;
  const logs = await client.getLogs({ address: m.address, fromBlock: block, toBlock: block });
  for (const log of logs) {
    const decoded = (() => {
      try {
        return decodeEventLog({ abi: marketAbi, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })();
    if (!decoded) continue;
    if (decoded.eventName !== "Settled" && decoded.eventName !== "Voided") continue;
    const hash = log.transactionHash as Hex;
    const [tx, blk] = await Promise.all([
      client.getTransaction({ hash }),
      client.getBlock({ blockNumber: block }),
    ]);
    let evidence: Hex | null = null;
    if (tx.to && isAddressEqual(tx.to, m.address)) {
      try {
        const call = decodeFunctionData({ abi: marketAbi, data: tx.input });
        if (call.functionName === "settle") evidence = call.args[0] as Hex;
      } catch {
        evidence = null;
      }
    }
    return {
      block,
      time: Number(blk.timestamp),
      hash,
      by: decoded.eventName === "Settled" ? (decoded.args as { settler: Address }).settler : tx.from,
      kind: decoded.eventName === "Settled" ? "settled" : "voided",
      evidence,
    };
  }
  return null;
}
