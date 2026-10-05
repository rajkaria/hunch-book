import { REPO_URL } from "@/lib/config";

// The app's main navigation, shared by the desktop bar and the mobile sheet.

export interface NavLink {
  href: string;
  label: string;
  /** Path prefixes that make this link the current page. */
  match: readonly string[];
}

/**
 * The header bar and the mobile menu. Hedge is the weekly job of the trader Hunch Book is built for,
 * and Status answers "is it solvent right now?", so both sit here beside trading and proof.
 */
export const NAV_LINKS: readonly NavLink[] = [
  { href: "/markets", label: "Markets", match: ["/markets", "/m/"] },
  { href: "/create", label: "Create", match: ["/create"] },
  { href: "/hedge", label: "Hedge", match: ["/hedge"] },
  { href: "/portfolio", label: "Portfolio", match: ["/portfolio"] },
  { href: "/proof", label: "Proof", match: ["/proof", "/verify/"] },
  { href: "/tape", label: "Tape", match: ["/tape"] },
  { href: "/status", label: "Status", match: ["/status"] },
];

/** The swipe feed is made for phones: the mobile menu lists it right after Markets; the bar does not. */
export const FEED_LINK: NavLink = { href: "/feed", label: "Feed", match: ["/feed"] };

/** The mobile menu: the bar's links with the feed after Markets. */
export const SHEET_LINKS: readonly NavLink[] = [NAV_LINKS[0] as NavLink, FEED_LINK, ...NAV_LINKS.slice(1)];

/**
 * Further product pages, listed in the footer. The funding calculator sits with the other tools here,
 * so the bar and the mobile menu keep their length; /hedge links to it as well.
 */
export const MORE_LINKS: readonly NavLink[] = [
  FEED_LINK,
  { href: "/calculator", label: "Funding calculator", match: ["/calculator"] },
  { href: "/ladder", label: "Ladders", match: ["/ladder"] },
  { href: "/parlay", label: "Parlays", match: ["/parlay"] },
  { href: "/rewards", label: "Rewards", match: ["/rewards"] },
  { href: "/settlements", label: "Settlements", match: ["/settlements"] },
];

/** The protocol docs on GitHub. */
export const DOCS_URL = `${REPO_URL}/blob/main/docs/PROTOCOL.md`;

export function isActive(pathname: string, link: NavLink): boolean {
  return link.match.some((m) => pathname === m || pathname.startsWith(m.endsWith("/") ? m : `${m}/`));
}
