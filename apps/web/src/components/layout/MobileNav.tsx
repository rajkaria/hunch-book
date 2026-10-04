"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appDeployment, appNetworkLabel, isDeployed, REPO_URL } from "@/lib/config";
import s from "./layout.module.css";
import { DOCS_URL, isActive, NAV_LINKS } from "./nav";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside `root`. Returns true when it moved focus. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== "Tab") return false;
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return false;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * The menu under 720px: a button that opens a sheet with the main links. While it is open, focus
 * stays inside it, Escape, a tap outside or the close button closes it, and focus goes back to the
 * menu button. The sheet is portalled to <body> so the blurred header cannot clip it.
 */
export function MobileNav() {
  const pathname = usePathname() ?? "/";
  // Read at render: the boundary above remounts this after a network switch.
  const networkStatus = isDeployed(appDeployment) ? "live" : "not deployed yet";
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const sheetId = useId();
  const titleId = useId();

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  // A new page closes the sheet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path changing is the trigger
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (sheet.current) {
        trapTab(e, sheet.current);
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (sheet.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    // The sheet only exists under 720px; growing the window past that closes it.
    const onResize = () => {
      if (window.innerWidth >= 720) close(false);
    };
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  return (
    <div className={s.mobileNav}>
      <button
        ref={trigger}
        type="button"
        className={s.menuButton}
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        aria-label="Menu"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={s.burger} data-open={open || undefined} aria-hidden="true">
          <span />
          <span />
        </span>
      </button>
      {open
        ? createPortal(
            <>
              <div className={s.scrim} aria-hidden="true" />
              <div
                ref={sheet}
                id={sheetId}
                className={s.sheet}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
              >
                <div className={s.sheetHead}>
                  <p className={s.sheetTitle} id={titleId}>
                    Menu
                  </p>
                  <button type="button" className={s.sheetClose} onClick={() => close()}>
                    Close
                  </button>
                </div>
                <nav aria-label="Main" className={s.sheetNav}>
                  {NAV_LINKS.map((link) => {
                    const active = isActive(pathname, link);
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        className={active ? `${s.sheetLink} ${s.sheetActive}` : s.sheetLink}
                        aria-current={active ? "page" : undefined}
                        onClick={() => close(false)}
                      >
                        {link.label}
                        <span aria-hidden="true">→</span>
                      </Link>
                    );
                  })}
                  <a className={s.sheetLink} href={DOCS_URL} target="_blank" rel="noreferrer">
                    Docs
                    <span aria-hidden="true">↗</span>
                  </a>
                </nav>
                <div className={s.sheetFoot}>
                  <p className={s.sheetStatus}>
                    <span className={s.sheetDot} aria-hidden="true" />
                    {appNetworkLabel}: {networkStatus}
                  </p>
                  <a href={REPO_URL} target="_blank" rel="noreferrer">
                    Source on GitHub
                  </a>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
