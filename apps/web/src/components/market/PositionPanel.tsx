"use client";

import { ONE_USDC, Outcome, Phase } from "@hunch-book/shared";
import Link from "next/link";
import { formatUsdc } from "@/lib/format";
import { useUserPosition, useWalletBalances } from "@/lib/hooks";
import { bookMid, PRICE_SCALE } from "@/lib/market/logic";
import type { MarketView } from "@/lib/market/types";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { Panel, Stat } from "../ui";
import s from "./market.module.css";

/** YES and NO tokens valued at the book's mid: YES at the mid, NO at 1 − mid. Null without a two-sided book. */
export function valueAtMid(m: Pick<MarketView, "quote">, tokens: { yes: bigint; no: bigint }): bigint | null {
  const mid = bookMid(m.quote);
  if (mid === null) return null;
  const midE6 = (mid * ONE_USDC) / PRICE_SCALE;
  return (tokens.yes * midE6 + tokens.no * (ONE_USDC - midE6)) / ONE_USDC;
}

/** What settled tokens are worth: the winning side at 1, the other at 0; after a void both at 0.50. */
export function settledValue(
  m: Pick<MarketView, "phase" | "outcome">,
  tokens: { yes: bigint; no: bigint },
): bigint | null {
  if (m.phase === Phase.Voided) return tokens.yes / 2n + tokens.no / 2n;
  if (m.phase !== Phase.Settled) return null;
  return m.outcome === Outcome.Yes ? tokens.yes : tokens.no;
}

/** The connected wallet's stake, claims and tokens in this market. Actions live in the Actions panel. */
export function PositionPanel({ m }: { m: MarketView }) {
  const wallet = useAppChain();
  const position = useUserPosition(m.address, wallet.address);
  const balances = useWalletBalances(wallet.address, m);
  if (!wallet.isConnected || !wallet.address) return null;
  const p = position.data;
  const held = { yes: balances.data?.yes ?? 0n, no: balances.data?.no ?? 0n };
  const atMid = m.graduated ? valueAtMid(m, held) : null;
  const final = settledValue(m, held);

  return (
    <Panel title="Your position" labelledBy="position-title">
      {position.isPending ? (
        <p className={s.laterNote}>Reading your position...</p>
      ) : position.isError || !p ? (
        <p className={s.laterNote}>Could not read your position. It refreshes on its own.</p>
      ) : (
        <>
          <div className={s.position}>
            <Stat label="Staked on YES" value={formatUsdc(p.stake.yes)} hint="USDC" />
            <Stat label="Staked on NO" value={formatUsdc(p.stake.no)} hint="USDC" />
            {m.graduated ? (
              <>
                <Stat label="YES to claim" value={formatUsdc(p.claimableTokens.yes)} hint="tokens" />
                <Stat label="NO to claim" value={formatUsdc(p.claimableTokens.no)} hint="tokens" />
                <Stat label="YES held" value={formatUsdc(held.yes)} hint="tokens" />
                <Stat label="NO held" value={formatUsdc(held.no)} hint="tokens" />
                {final !== null ? (
                  <Stat label="Worth at settlement" value={formatUsdc(final)} hint="USDC, before the fee" />
                ) : (
                  <Stat
                    label="Value at mid"
                    value={atMid === null ? "n/a" : formatUsdc(atMid)}
                    hint={atMid === null ? "no two-sided book" : "USDC"}
                  />
                )}
              </>
            ) : null}
            {!m.graduated && (m.phase === Phase.Settled || m.phase === Phase.Voided) ? (
              <Stat
                label="Pool payout to claim"
                value={formatUsdc(p.claimablePool.paid)}
                hint={
                  p.claimablePool.fee > 0n ? `after a ${formatUsdc(p.claimablePool.fee)} USDC fee` : "USDC"
                }
              />
            ) : null}
          </div>
          <p className={s.laterNote} style={{ marginTop: 12 }}>
            Every market you hold is on your <Link href="/portfolio">portfolio</Link>.
          </p>
        </>
      )}
    </Panel>
  );
}
