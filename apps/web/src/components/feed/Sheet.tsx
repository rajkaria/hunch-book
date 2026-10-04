"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trapTab } from "../layout/MobileNav";
import s from "./feed.module.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal sheet: slides up from the bottom on phones, a centred panel on wider screens. While open,
 * focus stays inside; Escape, the close button or a tap on the backdrop closes it, and focus returns to
 * whatever opened it. Portalled to <body> so no parent can clip it.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  // The latest onClose, so a parent that passes a new function each render does not re-run the open effect.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !mounted) return;
    opener.current = document.activeElement;
    const root = panel.current;
    root?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (root) trapTab(e, root);
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, mounted]);

  if (!open || !mounted) return null;
  return createPortal(
    <div className={s.sheetRoot}>
      <button type="button" className={s.sheetBackdrop} aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div
        ref={panel}
        className={wide ? `${s.sheet} ${s.sheetWide}` : s.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={s.sheetHead}>
          <h2 className={s.sheetTitle} id={titleId}>
            {title}
          </h2>
          <button type="button" className={s.sheetClose} onClick={onClose}>
            Close
          </button>
        </div>
        <div className={s.sheetBody}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
