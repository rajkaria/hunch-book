import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { parseAddressParam } from "@/lib/address";
import { getPublicClient } from "@/lib/chain/client";
import { readMarket } from "@/lib/chain/reads";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";
import { fallbackHeadline } from "@/lib/market/params";
import type { MarketView } from "@/lib/market/types";
import { CARD_COLORS as C, shareCard } from "@/lib/referral/card";

// Every market link's share card, in the Hunch look: ink with a lime and a violet glow, the market's
// question, its chance of YES with the YES/NO bar, and its phase. Read from the chain when the image is
// requested (cached for a minute); if the read is slow or fails, a plain Hunch Book card instead.

export const alt = "A Hunch Book market: its question, chance of YES and phase";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 60;

const READ_TIMEOUT_MS = 3_000;

const fontFile = (name: string) => readFile(join(process.cwd(), "public", "fonts", name));

async function loadMarket(raw: string): Promise<{ m: MarketView; headline: string } | null> {
  const address = parseAddressParam(raw);
  if (!address || !isDeployed(appDeployment)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([readMarket(getPublicClient(), appDeployment, address), timeout]);
    if (result?.status !== "ok") return null;
    const m = result.data;
    return { m, headline: m.description ?? fallbackHeadline(appDeployment, m.decoded) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function MarketShareImage({ params }: { params: Promise<{ address: string }> }) {
  const [heavy, medium, read] = await Promise.all([
    fontFile("archivo-latin-800-normal.woff"),
    fontFile("archivo-latin-500-normal.woff"),
    loadMarket((await params).address),
  ]);
  const card = shareCard(read?.m ?? null, read?.headline ?? null);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "56px 72px",
        position: "relative",
        backgroundColor: C.ink,
        color: C.paper,
        fontFamily: "Archivo",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          display: "flex",
          backgroundImage:
            "radial-gradient(circle at 92% 6%, rgba(139,92,246,0.45), transparent 46%), radial-gradient(circle at 4% 100%, rgba(203,255,93,0.2), transparent 44%)",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 15,
              background: C.lime,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="30" height="30" viewBox="0 0 100 100" aria-hidden="true">
              <path
                d="M6 6 H94 V94 H6 Z M33 94 V48 A17 17 0 0 1 67 48 V94 Z"
                fill={C.ink}
                fillRule="evenodd"
              />
            </svg>
          </div>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 800, letterSpacing: -1 }}>
            Hunch<span style={{ color: C.muted, marginLeft: 10 }}>Book</span>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 16px",
            borderRadius: 999,
            border: `1px solid ${card.phase.color}`,
            color: card.phase.color,
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          <div style={{ width: 10, height: 10, borderRadius: 5, background: card.phase.color }} />
          {card.phase.label}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          fontSize: card.questionSize,
          fontWeight: 800,
          lineHeight: 1.08,
          letterSpacing: -1.5,
          maxWidth: 1056,
        }}
      >
        {card.question}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {card.chance.value ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
            <div style={{ display: "flex", fontSize: 76, fontWeight: 800, letterSpacing: -2, color: C.lime }}>
              {card.chance.value}
            </div>
            <div style={{ display: "flex", fontSize: 26, fontWeight: 500, color: C.muted }}>
              {card.chance.caption}
            </div>
          </div>
        ) : null}
        {card.yesPct !== null ? (
          <div
            style={{ display: "flex", width: 1056, height: 14, borderRadius: 7, gap: 4, overflow: "hidden" }}
          >
            {card.yesPct > 0 ? (
              <div style={{ display: "flex", width: `${card.yesPct}%`, height: 14, background: C.lime }} />
            ) : null}
            {card.yesPct < 100 ? (
              <div style={{ display: "flex", flexGrow: 1, height: 14, background: C.coral }} />
            ) : null}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 22,
            fontWeight: 500,
            color: C.muted,
          }}
        >
          <div style={{ display: "flex" }}>{card.meta.join("  ·  ")}</div>
          <div style={{ display: "flex" }}>{appNetworkLabel}</div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Archivo", data: heavy, weight: 800, style: "normal" },
        { name: "Archivo", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
