import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deployments } from "@hunch-book/shared";
import { ImageResponse } from "next/og";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";

// The share card, in the main Hunch look: ink with a lime and a violet glow, the lime tile, and the
// three-stage headline in Archivo (read from public/fonts at build time, no network). Built once.

export const alt = "Hunch Book: start as a pool, graduate to a book, settle from the chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0b0b0f";
const PAPER = "#fafaf7";
const MUTED = "#b4b4ad";
const LIME = "#cbff5d";
const WARN = "#f6bd4f";

const fontFile = (name: string) => readFile(join(process.cwd(), "public", "fonts", name));

export default async function OpengraphImage() {
  const [heavy, medium] = await Promise.all([
    fontFile("archivo-latin-800-normal.woff"),
    fontFile("archivo-latin-500-normal.woff"),
  ]);
  const live = isDeployed(appDeployment);
  const mainnetLive = isDeployed(deployments["monad-mainnet"]);
  const pill = (text: string, color: string, border: string, background: string) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 18px",
        borderRadius: 999,
        border: `1px solid ${border}`,
        background,
        color,
        fontSize: 18,
        fontWeight: 500,
        letterSpacing: 2,
        textTransform: "uppercase",
      }}
    >
      <div style={{ width: 10, height: 10, borderRadius: 5, background: color }} />
      {text}
    </div>
  );
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        position: "relative",
        backgroundColor: INK,
        color: PAPER,
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
            "radial-gradient(circle at 92% 6%, rgba(139,92,246,0.5), transparent 46%), radial-gradient(circle at 6% 100%, rgba(203,255,93,0.24), transparent 44%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          display: "flex",
          backgroundImage:
            "linear-gradient(rgba(250,250,247,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(250,250,247,0.04) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
          opacity: 0.5,
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            background: LIME,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 48px rgba(203,255,93,0.35)",
          }}
        >
          <svg width="36" height="36" viewBox="0 0 100 100" aria-hidden="true">
            <path d="M6 6 H94 V94 H6 Z M33 94 V48 A17 17 0 0 1 67 48 V94 Z" fill={INK} fillRule="evenodd" />
          </svg>
        </div>
        <div style={{ display: "flex", fontSize: 44, fontWeight: 800, letterSpacing: -1.5 }}>
          Hunch<span style={{ color: MUTED, marginLeft: 12 }}>Book</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", fontSize: 84, fontWeight: 800, lineHeight: 1 }}>
        <div style={{ display: "flex", letterSpacing: -4 }}>Start as a pool.</div>
        <div style={{ display: "flex", letterSpacing: -4, marginTop: 6 }}>
          Graduate to a
          <div
            style={{
              display: "flex",
              marginLeft: 14,
              padding: "0 6px",
              backgroundImage: `linear-gradient(180deg, transparent 64%, ${LIME} 64%, ${LIME} 90%, transparent 90%)`,
            }}
          >
            book
          </div>
          .
        </div>
        <div style={{ display: "flex", letterSpacing: -4, marginTop: 6, color: MUTED }}>
          Settle from the chain.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 14 }}>
          {live
            ? pill(`Live on ${appNetworkLabel}`, LIME, "rgba(203,255,93,0.4)", "rgba(203,255,93,0.1)")
            : pill(`${appNetworkLabel}: building`, WARN, "rgba(246,189,79,0.4)", "rgba(246,189,79,0.1)")}
          {appNetworkLabel === "Monad testnet"
            ? pill(
                mainnetLive ? "Live on Monad mainnet" : "Mainnet planned",
                MUTED,
                "rgba(250,250,247,0.16)",
                "rgba(250,250,247,0.05)",
              )
            : null}
        </div>
        <div style={{ display: "flex", fontSize: 20, fontWeight: 500, color: MUTED }}>
          Monad · onchain order books · Perpl · Chainlink
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
