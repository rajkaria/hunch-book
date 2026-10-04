import { referralRegistryAbi } from "@hunch-book/shared";
import { type Address, getAbiItem, type Hex, type PublicClient } from "viem";

// Who bound to a referrer: ReferralRegistry's `Bound` events, which index the referrer. Monad's public
// RPCs answer eth_getLogs for at most 100 blocks, so the scan walks back from the head in 100-block
// windows, a few at a time, within a budget per call. The caller continues from `scannedFrom` to load
// older binds, down to the registry's deploy block.

export const LOG_RANGE = 100n;
/** eth_getLogs requests one scan call may spend. */
export const SCAN_BUDGET = 60;
const CONCURRENCY = 6;

const BOUND = getAbiItem({ abi: referralRegistryAbi, name: "Bound" });

export interface Bind {
  user: Address;
  referrer: Address;
  boundAt: bigint;
  expiresAt: bigint;
  relayer: Address;
  block: bigint;
  tx: Hex;
}

export interface BindScan {
  binds: Bind[];
  /** The lowest block the scan covered. */
  scannedFrom: bigint;
  /** The highest block the scan covered. */
  scannedTo: bigint;
  /** True once the scan reached `from` (the registry's deploy block). */
  complete: boolean;
}

/** 100-block windows from `to` down to `from`, newest first, at most `budget` of them. */
export function scanWindows(
  from: bigint,
  to: bigint,
  range = LOG_RANGE,
  budget = SCAN_BUDGET,
): { fromBlock: bigint; toBlock: bigint }[] {
  const windows: { fromBlock: bigint; toBlock: bigint }[] = [];
  let hi = to;
  while (hi >= from && windows.length < budget) {
    const lo = hi - range + 1n > from ? hi - range + 1n : from;
    windows.push({ fromBlock: lo, toBlock: hi });
    if (lo === 0n) break;
    hi = lo - 1n;
  }
  return windows;
}

/** Bound events for `referrer` between `from` and `to`, newest first, within the request budget. */
export async function scanBinds(
  client: Pick<PublicClient, "getLogs">,
  registry: Address,
  referrer: Address,
  { from, to, budget = SCAN_BUDGET }: { from: bigint; to: bigint; budget?: number },
): Promise<BindScan> {
  if (to < from) return { binds: [], scannedFrom: from, scannedTo: to, complete: true };
  const windows = scanWindows(from, to, LOG_RANGE, budget);
  const binds: Bind[] = [];
  for (let i = 0; i < windows.length; i += CONCURRENCY) {
    const wave = windows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      wave.map((w) =>
        client.getLogs({
          address: registry,
          event: BOUND,
          args: { referrer },
          fromBlock: w.fromBlock,
          toBlock: w.toBlock,
        }),
      ),
    );
    for (const logs of results) {
      for (const log of logs) {
        const a = log.args;
        if (!a.user || !a.referrer || a.boundAt === undefined || a.expiresAt === undefined) continue;
        binds.push({
          user: a.user,
          referrer: a.referrer,
          boundAt: BigInt(a.boundAt),
          expiresAt: BigInt(a.expiresAt),
          relayer: a.relayer ?? a.user,
          block: log.blockNumber ?? 0n,
          tx: (log.transactionHash ?? "0x") as Hex,
        });
      }
    }
  }
  const last = windows[windows.length - 1];
  const scannedFrom = last ? last.fromBlock : to;
  binds.sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
  return { binds, scannedFrom, scannedTo: to, complete: scannedFrom <= from };
}

/** Merges a newer scan with an older one (the older one continues below the newer one's range). */
export function mergeScans(newer: BindScan, older: BindScan): BindScan {
  const seen = new Set<string>();
  const binds = [...newer.binds, ...older.binds].filter((b) => {
    const key = `${b.tx}:${b.user}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    binds,
    scannedFrom: older.scannedFrom,
    scannedTo: newer.scannedTo,
    complete: older.complete,
  };
}

/** True while the binding is active at unix time `now`. */
export const bindActive = (b: Pick<Bind, "boundAt" | "expiresAt">, now: number): boolean =>
  BigInt(Math.floor(now)) >= b.boundAt && BigInt(Math.floor(now)) < b.expiresAt;
