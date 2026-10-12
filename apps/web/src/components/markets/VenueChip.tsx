import { Phase } from "@hunch-book/shared";
import type { MarketView } from "@/lib/market/types";
import { marketVenue, venueChipLabel } from "@/lib/stacks";
import { Badge, cx, type Tone } from "../ui";
import s from "./explorer.module.css";

// Where a market's book is: "Kuru", "Kuru v2" or "Hunch book", read from the market's stack. Only a
// market with a book says "Order book on Kuru" (to screen readers; the chip shows "Kuru"). A pool still
// taking stakes shows the venue its book would open on, and says "Graduates to Kuru". A pool that locked,
// settled or voided without graduating never had a book, so it shows no venue at all.

type VenueMarket = Pick<MarketView, "stack" | "venue" | "kuruVersion" | "phase" | "graduated" | "book">;

/** "book": it has an order book. "pool": a pool that can still graduate. null: it never will. */
export type VenueState = "book" | "pool" | null;

/** Whether a market has a book, could still get one, or never will (no venue chip then). */
export function venueState(m: Pick<MarketView, "phase" | "graduated" | "book">): VenueState {
  if (m.graduated && m.book) return "book";
  if (!m.graduated && Number(m.phase) === Phase.Pool) return "pool";
  return null;
}

/** Cyan for a Kuru book, violet for Hunch Book's own: kept apart from the lime of YES and the chance. */
export function venueTone(m: Pick<MarketView, "stack" | "venue" | "kuruVersion">): Tone {
  return marketVenue(m).venue === "hunch" ? "violet" : "cyan";
}

function VenueWords({ m, state }: { m: VenueMarket; state: "book" | "pool" }) {
  return (
    <>
      <span className="visually-hidden">{state === "book" ? "Order book on " : "Graduates to "}</span>
      {venueChipLabel(m)}
    </>
  );
}

/** The card's chip: a small square tag beside the phase tag. Nothing for a pool that never graduated. */
export function VenueChip({ m, className }: { m: VenueMarket; className?: string }) {
  const state = venueState(m);
  if (!state) return null;
  const venue = marketVenue(m).venue;
  return (
    <span className={cx(s.tag, venue === "hunch" ? s["tag-hunch"] : s["tag-kuru"], className)}>
      <VenueWords m={m} state={state} />
    </span>
  );
}

/** The market page header's chip: a pill like the phase badge beside it. Nothing without a book to come. */
export function VenueBadge({ m }: { m: VenueMarket }) {
  const state = venueState(m);
  if (!state) return null;
  return (
    <Badge tone={venueTone(m)} dot>
      <VenueWords m={m} state={state} />
    </Badge>
  );
}

/**
 * What to say where a market's book would be: "No book yet" while it can still graduate, else "No book:
 * it never graduated". `lead` replaces "No book" ("none" in a table cell).
 */
export function noBookWords(m: Pick<MarketView, "phase" | "graduated">, lead = "No book"): string {
  return !m.graduated && Number(m.phase) === Phase.Pool ? `${lead} yet` : `${lead}: it never graduated`;
}
