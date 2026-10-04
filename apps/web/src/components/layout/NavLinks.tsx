"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import s from "./layout.module.css";
import { DOCS_URL, isActive, NAV_LINKS } from "./nav";

/** The desktop navigation bar. Under 1100px the mobile sheet takes over. */
export function NavLinks() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className={s.nav} aria-label="Main">
      {NAV_LINKS.map((link) => {
        const active = isActive(pathname, link);
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
      <a className={s.navLink} href={DOCS_URL} target="_blank" rel="noreferrer">
        Docs
        <span className={s.navExternal} aria-hidden="true">
          ↗
        </span>
      </a>
    </nav>
  );
}
