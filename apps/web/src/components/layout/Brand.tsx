import Link from "next/link";
import { appNetwork } from "@/lib/config";
import s from "./layout.module.css";

/** The Hunch tile: a lime rounded square with the arch glyph, as in the main Hunch app. */
export function BrandTile({ size = 32 }: { size?: number }) {
  return (
    <span className={s.tile} style={{ width: size, height: size }} aria-hidden="true">
      <svg
        viewBox="0 0 100 100"
        width={Math.round(size * 0.56)}
        height={Math.round(size * 0.56)}
        focusable="false"
        aria-hidden="true"
      >
        <path
          d="M6 6 H94 V94 H6 Z M33 94 V48 A17 17 0 0 1 67 48 V94 Z"
          fill="currentColor"
          fillRule="evenodd"
        />
      </svg>
    </span>
  );
}

/** Tile, wordmark and, on testnet, a small network pill. Links home. */
export function Brand() {
  const testnet = appNetwork === "monad-testnet";
  return (
    <Link
      href="/"
      className={s.brand}
      aria-label={testnet ? "Hunch Book on testnet, home" : "Hunch Book, home"}
    >
      <BrandTile />
      <span className={s.brandText} aria-hidden="true">
        <span className={s.wordmark}>
          Hunch <span className={s.wordmarkBook}>Book</span>
        </span>
        {testnet ? <span className={s.networkPill}>Testnet</span> : null}
      </span>
    </Link>
  );
}
