import type { MarketView } from "@/lib/market/types";
import { marketVenue, venueChipLabel } from "@/lib/stacks";
import { Badge, cx, type Tone } from "../ui";
import s from "./explorer.module.css";

// Where a market's book is: "Kuru", "Kuru v2" or "Hunch book", read from the market's stack. A pool
// that has not graduated shows the venue its book will open on. Screen readers hear "Order book on
// Kuru".

type VenueMarket = Pick<MarketView, "stack" | "venue" | "kuruVersion">;

/** Cyan for a Kuru book, violet for Hunch Book's own: kept apart from the lime of YES and the chance. */
export function venueTone(m: VenueMarket): Tone {
  return marketVenue(m).venue === "hunch" ? "violet" : "cyan";
}

function VenueWords({ m }: { m: VenueMarket }) {
  return (
    <>
      <span className="visually-hidden">Order book on </span>
      {venueChipLabel(m)}
    </>
  );
}

/** The card's chip: a small square tag beside the phase tag. */
export function VenueChip({ m, className }: { m: VenueMarket; className?: string }) {
  const venue = marketVenue(m).venue;
  return (
    <span className={cx(s.tag, venue === "hunch" ? s["tag-hunch"] : s["tag-kuru"], className)}>
      <VenueWords m={m} />
    </span>
  );
}

/** The market page header's chip: a pill like the phase badge beside it. */
export function VenueBadge({ m }: { m: VenueMarket }) {
  return (
    <Badge tone={venueTone(m)} dot>
      <VenueWords m={m} />
    </Badge>
  );
}
