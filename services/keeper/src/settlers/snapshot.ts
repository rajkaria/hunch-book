import {
  decodeSnapshotParams,
  EMPTY_EVIDENCE,
  snapshotResolverAbi,
  snapshotWindowState,
} from "@hunch-book/shared";
import { revertReason } from "../tx.js";
import type { Settler } from "./index.js";
import { iso } from "./priceAtTime.js";

// Template 7, snapshot (docs/TEMPLATES.md, template 7). The value exists only as current state, so the
// resolver reads it once, in the first snapshot taken in [T, T + W], and keeps it. The market's
// `settle()` with empty evidence takes that snapshot when nobody has yet, so the keeper settles at the
// first cycle after T: one transaction takes the snapshot and settles. Every market on the same
// observation (source, T, W) then answers from that one snapshot.
// - Before T: wait.
// - A snapshot exists: settle from it, at any time up to the deadline.
// - Inside the window with no snapshot: settle, which takes it. If the source cannot be read right now
//   (Perpl upgraded, the value is stale), the keeper says why and tries again within seconds, because
//   the window is short.
// - After the window with no snapshot: the resolver can never answer; the market voids at its deadline.
//   Whoever takes the snapshot first chooses the block, so the keeper taking it at the first block after
//   T is what keeps that choice small.

/** Inside the window, a failed attempt is retried at most this many seconds later. */
const IN_WINDOW_RETRY_SECONDS = 5;

export const snapshotSettler: Settler = {
  name: "snapshot",

  waitReason(market, now) {
    const p = decodeSnapshotParams(market.params);
    if (snapshotWindowState(p.closeTime, p.snapshotWindow, now.timestamp) !== "before") return null;
    const end = p.closeTime + BigInt(p.snapshotWindow);
    return `waiting for close at ${p.closeTime} (${iso(p.closeTime)}): the snapshot window runs to ${end} (${iso(end)})`;
  },

  maxRetrySeconds(market, now) {
    const p = decodeSnapshotParams(market.params);
    return snapshotWindowState(p.closeTime, p.snapshotWindow, now.timestamp) === "open"
      ? IN_WINDOW_RETRY_SECONDS
      : undefined;
  },

  async evidence(market, now, deps) {
    const p = decodeSnapshotParams(market.params);
    const end = p.closeTime + BigInt(p.snapshotWindow);
    const [key, snap] = await deps.client.readContract({
      address: market.resolver,
      abi: snapshotResolverAbi,
      functionName: "snapshotFor",
      args: [market.params],
    });
    const base = { sourceId: p.sourceId, closeTime: p.closeTime, snapshotWindow: p.snapshotWindow, key };
    if (snap.blockNumber !== 0n) {
      return {
        status: "ready",
        evidence: EMPTY_EVIDENCE,
        value: 0n,
        detail: {
          ...base,
          snapshot: "taken",
          value: snap.value,
          snapshotBlock: snap.blockNumber,
          snapshotTime: snap.timestamp,
        },
      };
    }
    const state = snapshotWindowState(p.closeTime, p.snapshotWindow, now.timestamp);
    if (state === "after") {
      return {
        status: "unsettleable",
        reason: `nobody took the snapshot in its window, ${p.closeTime} to ${end} (${iso(end)}): the resolver can never answer`,
      };
    }
    if (state === "before") return { status: "wait", reason: `the snapshot window opens at ${p.closeTime}` };
    // Inside the window: settle takes the snapshot, if the source passes its checks right now.
    try {
      const current = await deps.client.readContract({
        address: market.resolver,
        abi: snapshotResolverAbi,
        functionName: "currentValue",
        args: [p.sourceId],
      });
      return {
        status: "ready",
        evidence: EMPTY_EVIDENCE,
        value: 0n,
        detail: { ...base, snapshot: "taken by this settle", valueNow: current, windowEnds: end },
      };
    } catch (error) {
      return {
        status: "wait",
        reason: `the source cannot be snapshotted right now (${revertReason(error, snapshotResolverAbi)}); the window runs to ${end}`,
      };
    }
  },
};
