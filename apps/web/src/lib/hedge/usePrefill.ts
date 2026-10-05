"use client";

import { useEffect, useRef, useState } from "react";
import { appDeployment } from "../config";
import { usePerpMeta } from "./hooks";
import type { PerpPosition } from "./math";
import { type HedgePrefill, parseHedgePrefill, perpIdOf, prefillPosition } from "./prefill";

/**
 * Reads a position from the page's query string once (/hedge?perp=BTC&side=long&size=0.5, see
 * prefill.ts) and hands it to `onAdd` as soon as the perp's lot decimals are read from Perpl. The query
 * is read in the browser, so the page itself stays static. Returns what was asked for, or null.
 */
export function useHedgePrefill(onAdd: (position: PerpPosition) => void): HedgePrefill | null {
  const [wanted, setWanted] = useState<{ prefill: HedgePrefill; perpId: bigint } | null>(null);
  useEffect(() => {
    const prefill = parseHedgePrefill(new URLSearchParams(window.location.search));
    const perpId = prefill ? perpIdOf(appDeployment, prefill.asset) : undefined;
    if (prefill && perpId !== undefined) setWanted({ prefill, perpId });
  }, []);
  const meta = usePerpMeta(wanted?.perpId);
  const added = useRef(false);
  useEffect(() => {
    if (added.current || !wanted || !meta.data || meta.data.perpId !== wanted.perpId) return;
    added.current = true;
    const position = prefillPosition(wanted.prefill, meta.data);
    if (position) onAdd(position);
  }, [wanted, meta.data, onAdd]);
  return wanted?.prefill ?? null;
}
