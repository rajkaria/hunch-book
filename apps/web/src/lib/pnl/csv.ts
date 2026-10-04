import type { Address } from "viem";
import { formatFixed } from "../format";
import { byOccurrence, type PnlEvent } from "./ledger";

// The wallet's history as CSV, built in the browser. Amounts are plain decimals (no thousands commas),
// times are ISO 8601 in UTC, and text cells that a spreadsheet could read as a formula are defused.

export const CSV_COLUMNS = [
  "time_utc",
  "block",
  "transaction",
  "market_number",
  "market",
  "question",
  "event",
  "side",
  "tokens",
  "usdc",
  "fee_usdc",
  "price_usdc",
  "via",
  "source",
] as const;

const EVENT_NAME: Record<PnlEvent["kind"], string> = {
  stake: "stake",
  claim: "claim tokens",
  poolPayout: "pool payout",
  buy: "buy",
  sell: "sell",
  mint: "mint sets",
  merge: "merge sets",
  redeem: "redeem",
};

const amount = (v: bigint): string => formatFixed(v, 6).replace(/,/g, "");

/** Quotes a cell when it needs it, and stops a spreadsheet from running a text cell as a formula. */
export function csvCell(value: string, text = false): string {
  let v = value;
  if (text && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface MarketLabel {
  number: number | null;
  question: string | null;
}

/** One row per event, oldest first, with a header row. */
export function historyCsv(
  events: readonly PnlEvent[],
  labels: ReadonlyMap<string, MarketLabel>,
  source: "indexer" | "chain",
): string {
  const rows = [...events].sort(byOccurrence).map((e) => {
    const label = labels.get(e.market.toLowerCase());
    const price =
      (e.kind === "buy" || e.kind === "sell" || e.kind === "redeem") && e.tokens > 0n
        ? amount((e.usdc * 1_000_000n) / e.tokens)
        : "";
    return [
      csvCell(e.time === null ? "" : new Date(e.time * 1000).toISOString()),
      csvCell(e.block === null ? "" : e.block.toString()),
      csvCell(e.tx ?? ""),
      csvCell(label?.number === null || label?.number === undefined ? "" : String(label.number)),
      csvCell(e.market),
      csvCell(label?.question ?? "", true),
      csvCell(EVENT_NAME[e.kind]),
      csvCell(e.side ? e.side.toUpperCase() : e.kind === "mint" || e.kind === "merge" ? "YES+NO" : ""),
      csvCell(e.tokens > 0n ? amount(e.tokens) : ""),
      csvCell(amount(e.usdc)),
      csvCell(e.fee > 0n ? amount(e.fee) : ""),
      csvCell(price),
      csvCell(e.via),
      csvCell(e.derived ? "chain state" : source === "indexer" ? "indexer" : "chain"),
    ].join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}

export function csvFilename(network: string, user: Address, now = new Date()): string {
  return `hunch-book-history-${network}-${user.slice(0, 8).toLowerCase()}-${now.toISOString().slice(0, 10)}.csv`;
}

/** Saves text as a file in the browser. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
