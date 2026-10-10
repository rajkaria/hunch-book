import { BPS, Outcome, Phase } from "@hunch-book/shared";
import { formatChance, formatUsdc } from "../format";
import { chanceDisplay, marketChance } from "../market/logic";
import { templateLabel } from "../market/params";
import type { MarketView } from "../market/types";
import { marketTag, venueShort } from "../stacks";

// What a market's share card (app/m/[address]/opengraph-image.tsx) says, as plain data, so the words and
// colours are tested without rendering an image.

export const CARD_COLORS = {
  ink: "#0b0b0f",
  paper: "#fafaf7",
  muted: "#b4b4ad",
  lime: "#cbff5d",
  coral: "#ff6f7d",
  warn: "#f6bd4f",
  cyan: "#5eead4",
  subtle: "#9a9a94",
} as const;

export interface ShareCard {
  question: string;
  /** Font size for the question, smaller for longer questions so it always fits. */
  questionSize: number;
  phase: { label: string; color: string };
  chance: { value: string; caption: string };
  /** YES share of the bar, 0 to 100, or null for no bar. */
  yesPct: number | null;
  meta: string[];
}

const MAX_QUESTION = 180;

export function fitQuestion(text: string): { question: string; size: number } {
  const clean = text.replace(/\s+/g, " ").trim();
  const question = clean.length > MAX_QUESTION ? `${clean.slice(0, MAX_QUESTION - 1).trimEnd()}…` : clean;
  const size = question.length <= 70 ? 62 : question.length <= 110 ? 52 : question.length <= 150 ? 44 : 38;
  return { question, size };
}

export function phaseColor(m: Pick<MarketView, "phase" | "outcome" | "venue" | "kuruVersion">): {
  label: string;
  color: string;
} {
  switch (m.phase) {
    case Phase.Pool:
      return { label: "Pool filling", color: CARD_COLORS.cyan };
    case Phase.Graduated:
      return { label: `Trading on ${venueShort(m)}`, color: CARD_COLORS.lime };
    case Phase.PoolLocked:
      return { label: "Pool locked", color: CARD_COLORS.warn };
    case Phase.Closed:
      return { label: "Closed, settling", color: CARD_COLORS.warn };
    case Phase.Settled:
      return m.outcome === Outcome.No
        ? { label: "Settled NO", color: CARD_COLORS.coral }
        : { label: "Settled YES", color: CARD_COLORS.lime };
    default:
      return { label: "Voided", color: CARD_COLORS.subtle };
  }
}

/** The card for a market, or for a link whose market could not be read (`m` null). */
export function shareCard(m: MarketView | null, headline: string | null): ShareCard {
  if (!m) {
    return {
      question: "A yes/no market on Monad that settles by reading the chain.",
      questionSize: 52,
      phase: { label: "Hunch Book market", color: CARD_COLORS.lime },
      chance: { value: "", caption: "" },
      yesPct: null,
      meta: [],
    };
  }
  const { question, size } = fitQuestion(headline ?? "A Hunch Book market");
  const chance = marketChance(m);
  const shown = chanceDisplay(chance);
  const meta = [templateLabel(m.templateId), `Market ${marketTag(m)}`];
  if (m.phase === Phase.Pool || m.phase === Phase.PoolLocked) {
    meta.push(
      `Pool ${formatUsdc(m.pool.total)} USDC, ${m.pool.stakers} ${m.pool.stakers === 1 ? "staker" : "stakers"}`,
    );
  }
  return {
    question,
    questionSize: size,
    phase: phaseColor(m),
    chance:
      chance.bps === null
        ? { value: "n/a", caption: chance.note }
        : shown.caption === "won"
          ? { value: shown.value, caption: "won" }
          : {
              value: formatChance(chance.bps),
              caption: chance.source === "book" ? "chance of YES, book mid" : "chance of YES, pool split",
            },
    yesPct: chance.bps === null ? null : Math.round((Number(chance.bps) / Number(BPS)) * 1000) / 10,
    meta,
  };
}
