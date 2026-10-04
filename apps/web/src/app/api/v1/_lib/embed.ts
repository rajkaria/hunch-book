import { formatBps, formatUsdc, type MarketInfo } from "@hunch-book/sdk";
import type { ApiDeps } from "./deps";
import { type ChainClock, marketTitleText, marketUrl, pointTime, priceString } from "./markets";

// The embeddable market card (/embed/m/<address>): one self-contained HTML page with no script, in the
// main Hunch app's style (ink, paper and lime, Archivo), sized for an iframe. Every value that comes
// from the chain is HTML-escaped. It refreshes itself every minute.

export const EMBED_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors *",
].join("; ");

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
@font-face{font-family:"Archivo";src:url("/fonts/archivo-latin-wght-normal.woff2") format("woff2");font-weight:100 900;font-display:swap}
:root{--ink:#0b0b0f;--paper:#fafaf7;--lime:#cbff5d;--coral:#ff5a6b;--no:#ff6f7d;--warn:#f6bd4f;--muted:#b4b4ad;--subtle:#9a9a94;
--surface:rgba(250,250,247,.04);--line:rgba(250,250,247,.1);--line-strong:rgba(250,250,247,.18);color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--paper);
background:radial-gradient(circle at 12% 0%,rgba(203,255,93,.09),transparent 18rem),radial-gradient(circle at 88% 6%,rgba(139,92,246,.16),transparent 20rem),#0b0b0f;
-webkit-font-smoothing:antialiased;line-height:1.5}
.card{display:flex;flex-direction:column;gap:12px;min-height:100%;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font-size:12px;color:var(--muted)}
.brand{display:inline-flex;align-items:center;gap:6px;font-family:"Archivo",ui-sans-serif,system-ui,sans-serif;font-weight:800;color:var(--paper);letter-spacing:-.02em}
.brand i{display:inline-block;width:14px;height:14px;border-radius:4px;background:var(--lime)}
.badge{display:inline-flex;align-items:center;padding:2px 9px;border:1px solid var(--line-strong);border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.accent{color:var(--lime);border-color:rgba(203,255,93,.35);background:rgba(203,255,93,.12)}
.warn{color:var(--warn);border-color:rgba(246,189,79,.35);background:rgba(246,189,79,.12)}
.muted{color:var(--subtle)}
.right{margin-left:auto}
h1{margin:0;font-family:"Archivo",ui-sans-serif,system-ui,sans-serif;font-size:16px;font-weight:700;line-height:1.3;letter-spacing:-.01em;text-wrap:balance}
.figures{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:8px 16px}
.chance{display:flex;flex-direction:column}
.value{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:28px;font-weight:700;line-height:1.1}
.label{font-size:12px;color:var(--muted)}
.bar{display:flex;gap:2px;height:8px;border-radius:999px;overflow:hidden;background:var(--line)}
.yes{background:var(--lime)}.no{background:var(--coral)}
.line{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:12px;color:var(--muted)}
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:auto;font-size:12px;color:var(--subtle)}
a.cta{margin-left:auto;display:inline-flex;align-items:center;min-height:32px;padding:6px 14px;border-radius:999px;background:var(--lime);color:var(--ink);font-weight:700;font-size:13px;text-decoration:none}
a.cta:hover{background:#d8ff85}
a.cta:focus-visible{outline:2px solid var(--paper);outline-offset:2px}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="60">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const TONE: Record<string, string> = {
  pool: "accent",
  trading: "accent",
  "pool-locked": "warn",
  closed: "warn",
  settled: "",
  voided: "muted",
};

function chanceText(m: MarketInfo): { value: string; label: string } {
  if (m.phaseName === "settled") return { value: m.outcomeLabel.toUpperCase(), label: "won" };
  if (m.phaseName === "voided") return { value: "Void", label: "redeems at 0.50" };
  if (m.chance.bps === null)
    return { value: "n/a", label: m.chance.source === "empty" ? "no stakes yet" : "no price yet" };
  const source =
    m.chance.source === "pool"
      ? "pool split"
      : m.chance.source === "book"
        ? "Kuru book mid"
        : "Kuru book, one side";
  return { value: formatBps(m.chance.bps) ?? "n/a", label: `chance of YES, ${source}` };
}

function whenText(m: MarketInfo, clock: ChainClock | null): string | null {
  const at = (v: bigint): string | null => {
    const iso = pointTime(m.window, v, clock);
    return iso
      ? `${iso.slice(0, 16).replace("T", " ")} UTC${m.window.blockClock ? " (estimated)" : ""}`
      : null;
  };
  if (m.phaseName === "pool") return at(m.window.lock) ? `Staking closes ${at(m.window.lock)}` : null;
  if (m.phaseName === "trading") return at(m.window.close) ? `Closes ${at(m.window.close)}` : null;
  if (m.phaseName === "pool-locked" || m.phaseName === "closed") return "Settles from onchain data";
  return null;
}

export function renderMarketCard(
  m: MarketInfo,
  deps: Pick<ApiDeps, "siteUrl" | "network">,
  clock: ChainClock | null,
): string {
  const chance = chanceText(m);
  const bps = m.chance.bps;
  const bar =
    bps === null
      ? `<div class="bar" role="img" aria-label="No chance to show yet"></div>`
      : `<div class="bar" role="img" aria-label="YES ${escapeHtml(formatBps(bps) ?? "")}">${bps > 0 ? `<span class="yes" style="flex:${bps} 1 0"></span>` : ""}${bps < 10_000 ? `<span class="no" style="flex:${10_000 - bps} 1 0"></span>` : ""}</div>`;
  const line =
    m.phaseName === "trading" && m.book
      ? `Bid ${priceString(m.prices?.bidE6) ?? "none"} · Ask ${priceString(m.prices?.askE6) ?? "none"} · Pool was ${formatUsdc(m.pool.total)} USDC`
      : `Pool ${formatUsdc(m.pool.total)} USDC · ${m.pool.stakers} ${m.pool.stakers === 1 ? "staker" : "stakers"}`;
  const when = whenText(m, clock);
  const url = marketUrl(deps, m.address);
  const title = marketTitleText(m, clock);
  const cta = m.phaseName === "pool" ? "Stake" : m.phaseName === "trading" ? "Trade" : "View";
  const body = `<main class="card">
<div class="meta"><span class="brand"><i aria-hidden="true"></i>Hunch Book</span><span class="badge ${TONE[m.phaseName] ?? ""}">${escapeHtml(m.phaseLabel)}</span><span>${escapeHtml(m.template)}</span><span class="right">#${m.id}</span></div>
<h1>${escapeHtml(title)}</h1>
<div class="figures"><div class="chance"><span class="value">${escapeHtml(chance.value)}</span><span class="label">${escapeHtml(chance.label)}</span></div><div>${bar}<div class="line">${escapeHtml(line)}</div></div></div>
<div class="foot">${when ? `<span>${escapeHtml(when)}</span>` : ""}<span>${deps.network === "monad-testnet" ? "Monad testnet" : "Monad"}</span><a class="cta" href="${escapeHtml(url)}" target="_blank" rel="noopener">${cta} on Hunch Book</a></div>
</main>`;
  return page(`${title} | Hunch Book`, body);
}

export function renderMessage(title: string, message: string, deps: Pick<ApiDeps, "siteUrl">): string {
  return page(
    `${title} | Hunch Book`,
    `<main class="card"><div class="meta"><span class="brand"><i aria-hidden="true"></i>Hunch Book</span></div><h1>${escapeHtml(title)}</h1><p class="line">${escapeHtml(message)}</p><div class="foot"><a class="cta" href="${escapeHtml(deps.siteUrl)}/markets" target="_blank" rel="noopener">See markets</a></div></main>`,
  );
}
