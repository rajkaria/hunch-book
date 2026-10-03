"use client";

import { marketAbi, Phase } from "@hunch-book/shared";
import Link from "next/link";
import type { Abi } from "viem";
import { formatUsdc } from "@/lib/format";
import { queryKeys, useUserPosition } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { useTxRunner } from "@/lib/wallet/useTxRunner";
import { Button, Panel, Stat } from "../ui";
import s from "./market.module.css";
import { TxList } from "./TxList";

/** The connected wallet's stake and claims here. Claims are single no-argument calls, so they are wired. */
export function PositionPanel({ m }: { m: MarketView }) {
  const wallet = useAppChain();
  const position = useUserPosition(m.address, wallet.address);
  const tx = useTxRunner([
    queryKeys.position(m.address, wallet.address ?? "0x"),
    queryKeys.market(m.address),
    queryKeys.portfolio(wallet.address ?? "0x"),
  ]);
  if (!wallet.isConnected || !wallet.address) return null;
  const p = position.data;
  const account = wallet.address;
  const canSend = wallet.onAppChain && !tx.busy;
  const tokens = p ? p.claimableTokens.yes + p.claimableTokens.no : 0n;
  const pool = p ? p.claimablePool.paid : 0n;

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
              </>
            ) : null}
            {m.phase === Phase.Settled || m.phase === Phase.Voided ? (
              <Stat
                label="Pool payout to claim"
                value={formatUsdc(p.claimablePool.paid)}
                hint={
                  p.claimablePool.fee > 0n ? `after a ${formatUsdc(p.claimablePool.fee)} USDC fee` : "USDC"
                }
              />
            ) : null}
          </div>
          <div className={s.steps} style={{ marginTop: 16 }}>
            {tokens > 0n ? (
              <Button
                block
                variant="primary"
                disabled={!canSend}
                onClick={() =>
                  void tx.run(
                    "Claim YES and NO tokens",
                    { address: m.address, abi: marketAbi as Abi, functionName: "claimTokens" },
                    account,
                  )
                }
              >
                Claim tokens
              </Button>
            ) : null}
            {pool > 0n ? (
              <Button
                block
                variant="primary"
                disabled={!canSend}
                onClick={() =>
                  void tx.run(
                    "Claim pool payout",
                    { address: m.address, abi: marketAbi as Abi, functionName: "claimPool" },
                    account,
                  )
                }
              >
                Claim {formatUsdc(pool)} USDC
              </Button>
            ) : null}
          </div>
          {tx.error ? (
            <p className={s.txError} role="alert">
              {tx.error}
            </p>
          ) : null}
          <TxList txs={tx.txs} />
          <p className={s.laterNote} style={{ marginTop: 12 }}>
            Every market you hold is on your <Link href="/portfolio">portfolio</Link>.
          </p>
        </>
      )}
    </Panel>
  );
}

/** Lifecycle calls that need more than one button press of wiring. Present, honest, disabled. */
export function LaterActions({ m }: { m: MarketView }) {
  const items: { label: string; when: string }[] = [];
  if (m.phase === Phase.Pool)
    items.push({ label: "Graduate to Kuru", when: "once the graduation rule is met" });
  if (m.phase === Phase.PoolLocked || m.phase === Phase.Closed)
    items.push({ label: "Settle", when: "anyone can settle after close" });
  if (m.phase === Phase.Settled || m.phase === Phase.Voided) {
    if (m.graduated) items.push({ label: "Redeem tokens", when: "winning tokens redeem for USDC" });
    items.push({ label: "Verify settlement", when: "re-run the read from your browser" });
  }
  if (items.length === 0) return null;
  return (
    <Panel title="Other actions" labelledBy="later-title">
      <div className={s.later}>
        {items.map((item) => (
          <Button key={item.label} block disabled title="Coming in the next build">
            {item.label}
          </Button>
        ))}
        <p className={s.laterNote}>
          Coming in the next build. Anyone will be able to call these; no one needs our permission.
          {m.phase === Phase.Settled ? (
            <>
              {" "}
              See what settled it on the <Link href={`/verify/${m.address}`}>verify page</Link>.
            </>
          ) : null}
        </p>
      </div>
    </Panel>
  );
}
