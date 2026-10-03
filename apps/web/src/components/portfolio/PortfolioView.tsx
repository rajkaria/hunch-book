"use client";

import Link from "next/link";
import { PORTFOLIO_WILL_SHOW } from "@/lib/copy";
import { formatUsdc, shortAddress } from "@/lib/format";
import { usePortfolio } from "@/lib/hooks";
import { phaseLabel, phaseTone } from "@/lib/market/logic";
import type { PortfolioEntry } from "@/lib/market/types";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { marketHeadline } from "../markets/MarketCard";
import ms from "../markets/markets.module.css";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { Badge, Panel, Stat } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import s from "./portfolio.module.css";

export function portfolioTotals(entries: PortfolioEntry[]) {
  let staked = 0n;
  let claimablePool = 0n;
  let claimableTokens = 0n;
  for (const e of entries) {
    staked += e.stake.yes + e.stake.no;
    claimablePool += e.claimablePool.paid;
    claimableTokens += e.claimableTokens.yes + e.claimableTokens.no;
  }
  return { staked, claimablePool, claimableTokens };
}

export function PortfolioRows({ entries }: { entries: PortfolioEntry[] }) {
  const totals = portfolioTotals(entries);
  return (
    <>
      <Panel title="Totals" labelledBy="totals-title">
        <div className={s.totals}>
          <Stat label="Markets" value={entries.length.toString()} />
          <Stat label="Staked" value={formatUsdc(totals.staked)} hint="USDC" />
          <Stat label="Tokens to claim" value={formatUsdc(totals.claimableTokens)} hint="YES + NO" />
          <Stat label="Pool payouts to claim" value={formatUsdc(totals.claimablePool)} hint="USDC" />
        </div>
      </Panel>
      <ul className={ms.list} style={{ marginTop: 16 }}>
        {entries.map((e) => (
          <li className={ms.card} key={e.market.address}>
            <div className={ms.meta}>
              <Badge tone={phaseTone(e.market.phase)}>{phaseLabel(e.market.phase)}</Badge>
              <span className="mono">#{e.market.marketId.toString()}</span>
            </div>
            <h2 className={ms.title}>
              <Link className={ms.titleLink} href={`/m/${e.market.address}`}>
                {marketHeadline(e.market)}
              </Link>
            </h2>
            <div className={s.figures}>
              <Stat label="Staked YES" value={formatUsdc(e.stake.yes)} />
              <Stat label="Staked NO" value={formatUsdc(e.stake.no)} />
              <Stat label="YES to claim" value={formatUsdc(e.claimableTokens.yes)} />
              <Stat label="NO to claim" value={formatUsdc(e.claimableTokens.no)} />
              <Stat label="YES held" value={formatUsdc(e.balances.yes)} />
              <Stat label="NO held" value={formatUsdc(e.balances.no)} />
              <Stat
                label="Pool payout to claim"
                value={formatUsdc(e.claimablePool.paid)}
                hint={e.claimablePool.fee > 0n ? `after ${formatUsdc(e.claimablePool.fee)} fee` : undefined}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className={ms.footnote}>
        Amounts in USDC; tokens use the same 6 decimals. Claims run from each market's page. P&amp;L and
        redemptions arrive with the indexer.
      </p>
    </>
  );
}

export function PortfolioView() {
  const wallet = useAppChain();
  const query = usePortfolio(wallet.address);

  if (!wallet.isConnected || !wallet.address) {
    return (
      <EmptyState
        label="No wallet"
        title="Connect a wallet to see your positions"
        actions={<ConnectButton />}
      >
        <p>This page is read-only. It reads your stakes and claims straight from each market contract.</p>
      </EmptyState>
    );
  }
  if (query.isPending) return <LoadingRows rows={3} label="Loading your positions" />;
  if (query.isError) {
    return <ErrorState title="Could not load your positions" onRetry={() => void query.refetch()} />;
  }
  if (query.data.status !== "ok") return <NotDeployed willShow={PORTFOLIO_WILL_SHOW} />;
  if (query.data.data.length === 0) {
    return (
      <EmptyState label="Nothing yet" title={`No positions for ${shortAddress(wallet.address)}`}>
        <p>
          Stake on a market and it shows up here. <Link href="/markets">Browse markets</Link>.
        </p>
      </EmptyState>
    );
  }
  return <PortfolioRows entries={query.data.data} />;
}
