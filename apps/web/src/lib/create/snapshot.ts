import {
  encodeSnapshotParams,
  SNAPSHOT_DEFAULT_WINDOW,
  SNAPSHOT_MAX_WINDOW,
  SNAPSHOT_MIN_WINDOW,
  type SnapshotComparator,
} from "@hunch-book/shared";
import type { Hex } from "viem";
import type { SnapshotSourceView } from "../snapshot";
import type { Issue } from "./build";
import { fromLocalInput, toLocalInput } from "./clock";
import { defaultPriceTimes, LOCK_LEAD_SECONDS, type LockLead, MIN_LEAD_SECONDS } from "./price";
import { parseFixed, roundSignificant, toInputString } from "./units";

// Template 7, snapshot: a value read onchain once, in the first snapshot taken right after close
// (Perpl open interest or mark price). The form's draft to canonical params, as a pure function like the
// other templates' builders. The resolver's own `validate` (run by the preview) is still the final word,
// and it also checks the source still reads as it did at deployment.

/** Snapshot window lengths the form offers, in seconds: 5, 10 and 30 minutes. */
export const SNAPSHOT_WINDOWS: readonly number[] = [300, SNAPSHOT_DEFAULT_WINDOW, SNAPSHOT_MAX_WINDOW];

export interface SnapshotDraft {
  /** The source id as a string ("" until one is picked). */
  sourceId: string;
  comparator: SnapshotComparator;
  /** The threshold in the source's unit, as typed. */
  threshold: string;
  /** Close: when the snapshot window opens, as a `datetime-local` value. */
  close: string;
  lockLead: LockLead;
  /** Only used when lockLead is "custom". */
  lock: string;
  /** Window length in seconds. */
  window: number;
}

export interface SnapshotBuild {
  params: Hex | null;
  source: SnapshotSourceView | null;
  threshold: bigint | null;
  lockTime: number | null;
  closeTime: number | null;
  issues: Issue[];
}

const issue = (field: string, message: string): Issue => ({ field, message });
const STAKING_LEAD = "at least 5 minutes from now, so the transaction lands before it";

/** Close at the next 12:00 UTC a day ahead, locked 24 hours before, a ten-minute window, "above". */
export function defaultSnapshotDraft(now: number, sources: readonly SnapshotSourceView[]): SnapshotDraft {
  const { lock, close } = defaultPriceTimes(now);
  return {
    sourceId: sources[0] ? String(sources[0].id) : "",
    comparator: 0,
    threshold: "",
    close: toLocalInput(close),
    lockLead: "day",
    lock: toLocalInput(lock),
    window: SNAPSHOT_DEFAULT_WINDOW,
  };
}

export function snapshotLockTime(
  draft: Pick<SnapshotDraft, "lockLead" | "lock">,
  closeTime: number | null,
): number | null {
  if (draft.lockLead === "custom") return fromLocalInput(draft.lock);
  return closeTime === null ? null : closeTime - LOCK_LEAD_SECONDS[draft.lockLead];
}

/** A starting threshold from the source's current value: three significant figures, as typed text. */
export function suggestedThreshold(value: bigint, source: Pick<SnapshotSourceView, "decimals">): string {
  const abs = value < 0n ? -value : value;
  const rounded = roundSignificant(abs, 3);
  return toInputString(value < 0n ? -rounded : rounded, source.decimals);
}

export function buildSnapshotParams(
  draft: SnapshotDraft,
  ctx: { sources: readonly SnapshotSourceView[]; now: number },
): SnapshotBuild {
  const source =
    draft.sourceId === "" ? null : (ctx.sources.find((s) => String(s.id) === draft.sourceId) ?? null);
  const out: SnapshotBuild = {
    params: null,
    source,
    threshold: null,
    lockTime: null,
    closeTime: null,
    issues: [],
  };
  const issues = out.issues;

  if (!source) issues.push(issue("source", "Pick the value to read."));
  else {
    const parsed = parseFixed(draft.threshold, source.decimals, {
      allowNegative: source.signed,
      unitName: source.label,
    });
    if (parsed === null) issues.push(issue("threshold", `Enter a level in ${source.unit}.`));
    else if (!parsed.ok) issues.push(issue("threshold", parsed.error));
    else out.threshold = parsed.value;
  }

  if (![0, 1, 2, 3].includes(draft.comparator))
    issues.push(issue("comparator", "Pick how the value is compared."));
  if (
    !Number.isInteger(draft.window) ||
    draft.window < SNAPSHOT_MIN_WINDOW ||
    draft.window > SNAPSHOT_MAX_WINDOW
  ) {
    issues.push(issue("window", "The snapshot window is 1 to 30 minutes long."));
  }

  out.closeTime = fromLocalInput(draft.close);
  if (out.closeTime === null) issues.push(issue("close", "Pick when the value is read."));
  out.lockTime = snapshotLockTime(draft, out.closeTime);
  if (out.lockTime === null) {
    if (draft.lockLead === "custom") issues.push(issue("lock", "Pick when staking stops."));
  } else if (out.lockTime < ctx.now + MIN_LEAD_SECONDS) {
    issues.push(
      issue(
        draft.lockLead === "custom" ? "lock" : "close",
        `Staking stops at the lock, which must be ${STAKING_LEAD}. Pick a later close or a shorter lead.`,
      ),
    );
  } else if (out.closeTime !== null && out.closeTime < out.lockTime) {
    issues.push(issue("lock", "The lock must be at or before the close."));
  }

  if (
    issues.length === 0 &&
    source &&
    out.threshold !== null &&
    out.lockTime !== null &&
    out.closeTime !== null
  ) {
    out.params = encodeSnapshotParams({
      sourceId: source.id,
      threshold: out.threshold,
      comparator: draft.comparator,
      lockTime: BigInt(out.lockTime),
      closeTime: BigInt(out.closeTime),
      snapshotWindow: draft.window,
    });
  }
  return out;
}
