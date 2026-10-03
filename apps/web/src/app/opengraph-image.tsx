import { ImageResponse } from "next/og";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";

// The share card: flat, same colours as the app, no gradients. Built once at build time.

export const alt = "Hunch Book: prediction markets that start as pools and graduate to an onchain order book";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0e0f0c";
const LINE = "#2a2d25";
const TEXT = "#ecefe6";
const MUTED = "#a2a797";
const LIME = "#c6f432";

export default function OpengraphImage() {
  const status = isDeployed(appDeployment) ? `Live on ${appNetworkLabel}` : `${appNetworkLabel}: building`;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background: BG,
        color: TEXT,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 28, height: 28, background: LIME, borderRadius: 4 }} />
        <div style={{ fontSize: 30, letterSpacing: 6, fontWeight: 700 }}>HUNCH BOOK</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ fontSize: 68, lineHeight: 1.08, fontWeight: 700, maxWidth: 1000, letterSpacing: -1 }}>
          Prediction markets that start as pools and graduate to an onchain order book.
        </div>
        <div style={{ fontSize: 30, color: MUTED, maxWidth: 980, lineHeight: 1.4 }}>
          Sell before the answer on Kuru. Settled by reading the chain, not by a person.
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingTop: 28,
          borderTop: `2px solid ${LINE}`,
          fontSize: 26,
          color: MUTED,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, color: LIME }}>
          <div style={{ width: 14, height: 14, borderRadius: 7, background: LIME }} />
          {status}
        </div>
        <div style={{ display: "flex" }}>Monad · Kuru · Perpl · Chainlink</div>
      </div>
    </div>,
    size,
  );
}
