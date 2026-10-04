"use client";

import { collateralVaultAbi, marketAbi, Phase, Side } from "@hunch-book/shared";
import Link from "next/link";
import type { Abi, Address } from "viem";
import { appNetwork, appNetworkLabel } from "@/lib/config";
import { PORTFOLIO_WILL_SHOW } from "@/lib/copy";
import { formatUsdc, shortAddress } from "@/lib/format";
import { usePortfolio, useProtocolAddresses } from "@/lib/hooks";
import { phaseLabel, phaseTone } from "@/lib/market/logic";
import {
  entryPlan,
  entryRedeemable,
  entryValueAtMid,
  type PlannedAction,
  portfolioPlan,
  portfolioTotals,
} from "@/lib/market/portfolio";
import type { PortfolioEntry } from "@/lib/market/types";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, type TxStep, useTxRunner } from "@/lib/wallet/useTxRunner";
import { PortfolioPeriphery } from "../autoredeem/PortfolioPeriphery";
import { TxList } from "../market/TxList";
import { marketHeadline } from "../markets/MarketCard";
import ms from "../markets/markets.module.css";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { Badge, Button, Panel, Stat } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import { FaucetButton, useFaucetAvailable } from "../wallet/Faucet";
import s from "./portfolio.module.css";

// Every portfolio write refreshes all portfolio, position, balance and market reads.
const REFRESH = [
  ["portfolio", appNetwork],
  ["position", appNetwork],
  ["balances", appNetwork],
  ["markets", appNetwork],
  ["market", appNetwork],
  ["usdc", appNetwork],
];

/** One planned call as a write: market calls for claims, the vault for redemptions. */
export function toTxStep(action: PlannedAction, vault: Address, user: Address): TxStep {
  if (action.kind === "redeem") {
    return {
      label: action.label,
      request: {
        address: vault,
        abi: collateralVaultAbi as Abi,
        functionName: "redeem",
        args: [action.market.address, action.side, action.amount, user],
      },
    };
  }
  return {
    label: action.label,
    request: { address: action.market.address, abi: marketAbi as Abi, functionName: action.kind },
  };
}

const ACTION_BUTTON: Record<PlannedAction["kind"], string> = {
  claimTokens: "Claim tokens",
  redeem: "Redeem",
  claimPool: "Claim pool payout",
};

export function PortfolioRows({ entries }: { entries: PortfolioEntry[] }) {
  const wallet = useAppChain();
  const protocol = useProtocolAddresses();
  const tx = useTxRunner(REFRESH);
  const totals = portfolioTotals(entries);
  const plan = portfolioPlan(entries);
  const user = wallet.address;
  const vault = protocol.data?.vault;
  const ready = Boolean(user && vault && wallet.onAppChain) && !tx.busy;
  const sendPlan = (actions: PlannedAction[]) => {
    if (!user || !vault || actions.length === 0) return;
    void tx.runAll(
      actions.map((a) => toTxStep(a, vault, user)),
      user,
    );
  };

  return (
    <>
      <Panel title="Totals" labelledBy="totals-title">
        <div className={s.totals}>
          <Stat label="Markets" value={entries.length.toString()} />
          <Stat label="Staked" value={formatUsdc(totals.staked)} hint="USDC" />
          <Stat label="Tokens to claim" value={formatUsdc(totals.claimableTokens)} hint="YES + NO" />
          <Stat label="Token value" value={formatUsdc(totals.value)} hint="USDC at mid, or settled" />
          <Stat label="Redeemable now" value={formatUsdc(totals.payable)} hint="USDC, after fees" />
          <Stat label="Pool payouts to claim" value={formatUsdc(totals.claimablePool)} hint="USDC" />
        </div>
        <div className={s.claimAll}>
          <div>
            <p className={s.claimAllTitle}>Claim all and redeem all</p>
            <p className={s.note}>
              {plan.length === 0
                ? "Nothing to claim or redeem right now."
                : `${plan.length} ${plan.length === 1 ? "transaction" : "transactions"}, sent one by one, paying ${formatUsdc(totals.payable)} USDC in total. Each is checked against the chain before your wallet opens.`}
            </p>
          </div>
          <Button variant="primary" disabled={!ready || plan.length === 0} onClick={() => sendPlan(plan)}>
            {tx.busy && tx.progress
              ? `${stageText(tx.stage)} ${Math.min(tx.progress.done + 1, tx.progress.total)} of ${tx.progress.total}`
              : "Claim and redeem all"}
          </Button>
        </div>
        {wallet.wrongNetwork ? (
          <p className={s.note}>
            Switch your wallet to {appNetworkLabel} to send these. <ConnectButton />
          </p>
        ) : null}
        {tx.error ? (
          <p className={s.error} role="alert">
            {tx.error}
          </p>
        ) : null}
        <TxList txs={tx.txs} />
      </Panel>

      <FaucetPanel />
      <PortfolioPeriphery entries={entries} user={user} />

      <ul className={ms.list} style={{ marginTop: 16 }}>
        {entries.map((e) => {
          const actions = entryPlan(e);
          const value = entryValueAtMid(e);
          const redeemable = entryRedeemable(e);
          return (
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
                  label={
                    e.market.phase === Phase.Settled || e.market.phase === Phase.Voided
                      ? "Token value (settled)"
                      : "Value at mid"
                  }
                  value={value === null ? "n/a" : formatUsdc(value)}
                  hint={
                    value === null
                      ? e.market.graduated
                        ? "no two-sided book"
                        : "pool, no tokens"
                      : undefined
                  }
                />
                <Stat label="Redeemable now" value={formatUsdc(redeemable)} />
                <Stat
                  label="Pool payout to claim"
                  value={formatUsdc(e.claimablePool.paid)}
                  hint={e.claimablePool.fee > 0n ? `after ${formatUsdc(e.claimablePool.fee)} fee` : undefined}
                />
              </div>
              {actions.length > 0 ? (
                <div className={s.rowActions}>
                  {actions.map((a) => (
                    <Button
                      key={`${a.kind}-${a.side ?? ""}`}
                      size="sm"
                      variant="primary"
                      disabled={!ready}
                      title={a.label}
                      onClick={() => sendPlan([a])}
                    >
                      {ACTION_BUTTON[a.kind]}
                      {a.kind === "redeem" ? ` ${a.side === Side.Yes ? "YES" : "NO"}` : ""}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className={ms.footnote}>
        Amounts in USDC; tokens use the same 6 decimals. Value at mid prices YES at the book's mid and NO at
        one minus it. Redemptions pay the fixed per-token fee set at graduation. P&amp;L arrives with the
        indexer.
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
        <p>It reads your stakes, claims and tokens straight from each market contract.</p>
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
      <>
        <EmptyState label="Nothing yet" title={`No positions for ${shortAddress(wallet.address)}`}>
          <p>
            Stake on a market and it shows up here. <Link href="/markets">Browse markets</Link>.
          </p>
        </EmptyState>
        <div style={{ marginTop: 16 }}>
          <FaucetPanel />
        </div>
        <PortfolioPeriphery entries={[]} user={wallet.address} />
      </>
    );
  }
  return <PortfolioRows entries={query.data.data} />;
}

function FaucetPanel() {
  const faucet = useFaucetAvailable();
  if (!faucet) return null;
  return (
    <Panel title="Testnet funds" labelledBy="faucet-title">
      <FaucetButton />
    </Panel>
  );
}
