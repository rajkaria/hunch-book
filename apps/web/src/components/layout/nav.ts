import { REPO_URL } from "@/lib/config";

// The app's main navigation, shared by the desktop bar and the mobile sheet.

export interface NavLink {
  href: string;
  label: string;
  /** Path prefixes that make this link the current page. */
  match: readonly string[];
}

export const NAV_LINKS: readonly NavLink[] = [
  { href: "/markets", label: "Markets", match: ["/markets", "/m/"] },
  { href: "/create", label: "Create", match: ["/create"] },
  { href: "/portfolio", label: "Portfolio", match: ["/portfolio"] },
  { href: "/proof", label: "Proof", match: ["/proof", "/verify/"] },
];

/** The protocol docs on GitHub. */
export const DOCS_URL = `${REPO_URL}/blob/main/docs/PROTOCOL.md`;

export function isActive(pathname: string, link: NavLink): boolean {
  return link.match.some((m) => pathname === m || pathname.startsWith(m.endsWith("/") ? m : `${m}/`));
}
