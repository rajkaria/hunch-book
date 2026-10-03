"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import s from "./layout.module.css";

const LINKS = [
  { href: "/markets", label: "Markets", match: ["/markets", "/m/"] },
  { href: "/portfolio", label: "Portfolio", match: ["/portfolio"] },
  { href: "/proof", label: "Proof", match: ["/proof", "/verify/"] },
] as const;

export function NavLinks() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className={s.nav} aria-label="Main">
      {LINKS.map((link) => {
        const active = link.match.some(
          (m) => pathname === m || pathname.startsWith(m.endsWith("/") ? m : `${m}/`),
        );
        return (
          <Link
            key={link.href}
            href={link.href}
            className={active ? `${s.navLink} ${s.navActive}` : s.navLink}
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
