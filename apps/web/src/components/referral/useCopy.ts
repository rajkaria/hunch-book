"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Copies text to the clipboard; `copied` stays true for two seconds. False when the browser refuses. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async (text: string): Promise<boolean> => {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2_000);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  }, []);
  return { copy, copied, failed };
}

/** This page's origin in the browser (so preview deployments share their own links), else the site. */
export function currentOrigin(fallback: string): string {
  try {
    return typeof window !== "undefined" && window.location?.origin ? window.location.origin : fallback;
  } catch {
    return fallback;
  }
}
