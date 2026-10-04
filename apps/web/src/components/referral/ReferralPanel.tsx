"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { Address } from "viem";
import { appNetworkLabel, SITE_URL } from "@/lib/config";
import { formatBpsPercent, formatInt, formatUsdc, formatUtc } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { bindActive } from "@/lib/referral/binds";
import { estimateCredit, indexerUrl, PLANNED_REFERRAL_SHARE_BPS } from "@/lib/referral/earnings";
import { referralRegistryAddress, useBinding, useReferralBinds, useReferralFees } from "@/lib/referral/hooks";
import { referralUrl } from "@/lib/referral/link";
import { AddressLink, Badge, Button, Panel, Stat, TxLink } from "../ui";
import { REFERRAL_DOCS_URL } from "./ReferralLanding";
import s from "./referral.module.css";
import { currentOrigin, useCopy } from "./useCopy";

/** Binds listed before "Show all". */
const SHOWN_BINDS = 8;

/** The portfolio's "Your referral link": the link, who bound to it, and what it may earn. */
export function ReferralPanel({ user }: { user: Address }) {
  const registry = referralRegistryAddress();
  const now = useNow(30_000);
  const { copy, copied, failed } = useCopy();
  const own = useBinding(user);
  const scan = useReferralBinds(registry ? user : undefined);
  const binds = useMemo(() => scan.data?.pages.flatMap((p) => p.binds) ?? [], [scan.data]);
  const users = useMemo(() => [...new Set(binds.map((b) => b.user))], [binds]);
  const fees = useReferralFees(registry ? user : undefined, users);
  const link = referralUrl(currentOrigin(SITE_URL), user);

  if (!registry) {
    return (
      <Panel title="Your referral link" labelledBy="referral-title">
        <p className={s.note}>The referral registry is not deployed on {appNetworkLabel} yet.</p>
      </Panel>
    );
  }

  const pages = scan.data?.pages ?? [];
  const lastPage = pages[pages.length - 1];
  const firstPage = pages[0];
  const active = now === null ? 0 : binds.filter((b) => bindActive(b, now)).length;
  const credit = fees.data ? estimateCredit(binds, fees.data) : null;
  const hasIndexer = indexerUrl() !== null;

  return (
    <Panel
      title="Your referral link"
      labelledBy="referral-title"
      aside={
        <a className={s.docs} href={REFERRAL_DOCS_URL} target="_blank" rel="noreferrer">
          How it works ↗
        </a>
      }
    >
      <div className={s.linkRow}>
        <input
          className={s.linkInput}
          readOnly
          value={link}
          aria-label="Your referral link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button size="sm" variant="primary" onClick={() => void copy(link)}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <p className={s.note} aria-live="polite">
        {failed
          ? "This browser blocked the clipboard. Select the link and copy it by hand."
          : "Anyone who opens it and binds is your referred user for 180 days. Every market's Share button can add it too."}
      </p>

      <div className={s.stats}>
        <Stat
          label="Binds found"
          value={formatInt(binds.length)}
          hint={scan.isPending ? "reading..." : "all time"}
        />
        <Stat label="Active now" value={formatInt(active)} hint="within 180 days" />
        <Stat
          label="Estimated earnings"
          value={credit ? formatUsdc(credit.total) : "n/a"}
          tone={credit ? undefined : "muted"}
          hint={
            !hasIndexer
              ? "needs the indexer"
              : fees.isError
                ? "indexer unavailable"
                : credit
                  ? `USDC, from ${formatInt(credit.counted)} fee ${credit.counted === 1 ? "event" : "events"}`
                  : binds.length === 0
                    ? "no binds yet"
                    : "reading..."
          }
        />
      </div>
      <p className={s.note}>
        Earnings are an estimate at the planned share of{" "}
        {formatBpsPercent(Number(PLANNED_REFERRAL_SHARE_BPS))} of the protocol's part of each fee your
        referred users pay. They are paid in epochs through the rewards distributor:{" "}
        <Link href="/rewards">claim them on the rewards page</Link>.
        {hasIndexer ? "" : " This app is not connected to the indexer yet, so it cannot add up the fees."}
      </p>

      {own.data?.active ? (
        <p className={s.note}>
          Your own wallet is bound to <AddressLink address={own.data.referrer} /> until{" "}
          {formatUtc(own.data.expiresAt)}.
        </p>
      ) : null}

      {scan.isError ? (
        <p className={s.error} role="alert">
          Could not read binds from the chain.{" "}
          <Button size="sm" variant="ghost" onClick={() => void scan.refetch()}>
            Try again
          </Button>
        </p>
      ) : binds.length > 0 ? (
        <ul className={s.binds}>
          {binds.slice(0, SHOWN_BINDS).map((b) => {
            const live = now !== null && bindActive(b, now);
            const earned = credit?.perUser.get(b.user.toLowerCase());
            return (
              <li className={s.bind} key={`${b.tx}-${b.user}`}>
                <span className={s.bindWho}>
                  <AddressLink address={b.user} />
                  <Badge tone={live ? "accent" : "muted"} dot>
                    {live ? "Active" : "Expired"}
                  </Badge>
                </span>
                <span className={s.bindWhen}>
                  Bound {formatUtc(b.boundAt)}, ends {formatUtc(b.expiresAt)}
                  {earned !== undefined ? ` · about ${formatUsdc(earned)} USDC` : ""}
                </span>
                <TxLink hash={b.tx} />
              </li>
            );
          })}
        </ul>
      ) : null}
      {binds.length > SHOWN_BINDS ? (
        <p className={s.note}>And {formatInt(binds.length - SHOWN_BINDS)} more.</p>
      ) : null}
      {firstPage && lastPage ? (
        <div className={s.row}>
          <p className={s.note}>
            Read from chain logs, block {formatInt(lastPage.scannedFrom)} to {formatInt(firstPage.scannedTo)}
            {lastPage.complete ? ", back to the registry's deployment." : "."}
          </p>
          {scan.hasNextPage ? (
            <Button size="sm" onClick={() => void scan.fetchNextPage()} loading={scan.isFetchingNextPage}>
              Load older binds
            </Button>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
