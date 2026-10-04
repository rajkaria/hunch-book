import {
  decodeParlayParams,
  EMPTY_EVIDENCE,
  marketAbi,
  Outcome,
  PHASE_LABEL,
  Phase,
} from "@hunch-book/shared";
import type { Address } from "viem";
import type { EvidenceResult, Settler } from "./index.js";
import { iso } from "./priceAtTime.js";

// Template 6, parlay (docs/TEMPLATES.md). The resolver reads each leg's settled outcome: NO as soon as
// any leg has settled NO, YES once every leg has settled YES, otherwise Unresolved. A leg that voids
// while no leg is NO leaves the parlay without an answer for good, so it voids at its deadline. The
// evidence is empty; the keeper reads the legs first so it only sends `settle` when it will go through.

export interface LegState {
  address: Address;
  phase: Phase;
  outcome: Outcome;
}

export type ParlayAnswer =
  | { status: "ready"; answer: "yes" | "no"; reason: string }
  | { status: "wait"; reason: string }
  | { status: "unsettleable"; reason: string };

const legName = (leg: LegState) => `${leg.address} (${PHASE_LABEL[leg.phase]})`;

/** What the resolver will answer for these legs, in plain words. Pure. */
export function parlayAnswer(legs: readonly LegState[]): ParlayAnswer {
  const no = legs.find((l) => l.outcome === Outcome.No);
  if (no) return { status: "ready", answer: "no", reason: `leg ${no.address} settled NO` };
  if (legs.length > 0 && legs.every((l) => l.outcome === Outcome.Yes)) {
    return { status: "ready", answer: "yes", reason: `all ${legs.length} legs settled YES` };
  }
  const voided = legs.filter((l) => l.phase === Phase.Voided);
  const open = legs.filter((l) => l.phase !== Phase.Voided && l.phase !== Phase.Settled);
  if (voided.length > 0 && open.length === 0) {
    return {
      status: "unsettleable",
      reason: `leg ${voided.map((l) => l.address).join(", ")} voided and no leg settled NO: the parlay voids at its deadline`,
    };
  }
  if (voided.length > 0) {
    return {
      status: "wait",
      reason: `leg ${voided.map((l) => l.address).join(", ")} voided; the parlay settles NO only if one of ${open.map(legName).join(", ")} settles NO, and otherwise voids`,
    };
  }
  return { status: "wait", reason: `waiting for legs ${open.map(legName).join(", ")}` };
}

export const parlaySettler: Settler = {
  name: "parlay",

  waitReason(market, now) {
    const p = decodeParlayParams(market.params);
    return now.timestamp >= p.closeTime ? null : `waiting for close at ${p.closeTime} (${iso(p.closeTime)})`;
  },

  async evidence(market, _now, deps): Promise<EvidenceResult> {
    const p = decodeParlayParams(market.params);
    const reads = await deps.client.multicall({
      allowFailure: false,
      contracts: p.legs.flatMap((leg) => [
        { address: leg, abi: marketAbi, functionName: "phase" as const },
        { address: leg, abi: marketAbi, functionName: "outcome" as const },
      ]),
    });
    const legs: LegState[] = p.legs.map((address, i) => ({
      address,
      phase: reads[2 * i] as Phase,
      outcome: reads[2 * i + 1] as Outcome,
    }));
    const answer = parlayAnswer(legs);
    if (answer.status !== "ready") return answer;
    return {
      status: "ready",
      evidence: EMPTY_EVIDENCE,
      value: 0n,
      detail: { answer: answer.answer, reason: answer.reason, legs: legs.map((l) => l.address) },
    };
  },
};
