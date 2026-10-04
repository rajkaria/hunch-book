"use client";

import { useState } from "react";
import { SITE_URL } from "@/lib/config";
import type { MarketView } from "@/lib/market/types";
import { referralRegistryAddress } from "@/lib/referral/hooks";
import { marketPath, marketUrl, referralUrl } from "@/lib/referral/link";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { Sheet } from "../feed/Sheet";
import { Button } from "../ui";
import s from "./referral.module.css";
import { currentOrigin, useCopy } from "./useCopy";

/** The share card's path: Next serves app/m/[address]/opengraph-image.tsx here. */
export const shareCardPath = (m: Pick<MarketView, "address">): string =>
  `${marketPath(m.address)}/opengraph-image`;

/**
 * "Share": copy the market's link (with your referral, if you like), see the card it unfurls as, post it.
 * `title` is the market's title as the page shows it (lib/market/title.ts).
 */
export function ShareMarket({ m, title }: { m: MarketView; title: string }) {
  const [open, setOpen] = useState(false);
  const wallet = useAppChain();
  const [withReferral, setWithReferral] = useState(true);
  const { copy, copied, failed } = useCopy();
  const origin = currentOrigin(SITE_URL);
  const canRefer = Boolean(wallet.address && referralRegistryAddress());
  const link =
    canRefer && withReferral && wallet.address
      ? referralUrl(origin, wallet.address, marketPath(m.address))
      : marketUrl(origin, m.address);
  const headline = title;
  const postUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(headline)}&url=${encodeURIComponent(link)}`;
  const nativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function"
      ? () => void navigator.share({ title: headline, url: link }).catch(() => undefined)
      : null;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Share
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Share this market" wide>
        <figure className={s.card}>
          {/* biome-ignore lint/performance/noImgElement: the share card is a generated PNG route; next/image adds nothing */}
          <img
            className={s.cardImage}
            src={shareCardPath(m)}
            alt={`Share card: ${headline}`}
            width={1200}
            height={630}
            loading="lazy"
          />
          <figcaption className={s.note}>This is how the link unfurls in chats and posts.</figcaption>
        </figure>
        <div className={s.linkRow}>
          <input
            className={s.linkInput}
            readOnly
            value={link}
            aria-label="Link to share"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button size="sm" variant="primary" onClick={() => void copy(link)}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        <p className={s.note} aria-live="polite">
          {failed ? "This browser blocked the clipboard. Select the link and copy it by hand." : null}
        </p>
        {canRefer ? (
          <label className={s.check}>
            <input
              type="checkbox"
              checked={withReferral}
              onChange={(e) => setWithReferral(e.target.checked)}
            />
            Include my referral: people who open it can bind your wallet as their referrer. It still lands on
            this market and unfurls with this card.
          </label>
        ) : null}
        <div className={s.row}>
          <a className={s.post} href={postUrl} target="_blank" rel="noreferrer">
            Post on X ↗
          </a>
          {nativeShare ? (
            <Button size="sm" onClick={nativeShare}>
              More ways to share
            </Button>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}
