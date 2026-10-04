"use client";

import { Side } from "@hunch-book/shared";
import { LOW_MON_WEI } from "@/lib/account/gas";
import { formatUsdc } from "@/lib/format";
import { queryKeys, useMonBalance, useProtocolAddresses } from "@/lib/hooks";
import type { MarketView } from "@/lib/market/types";
import { relayStageText, useRelayedStake, useRelayStatus } from "@/lib/relayer/hooks";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { TxList } from "../market/TxList";
import { Button } from "../ui";
import { GasHelp } from "./AccountPanel";
import s from "./account.module.css";

/**
 * Shown under the stake button when the account has too little MON for gas. With the relayer on,
 * the person signs a USDC authorisation for exactly this market, side and amount and the relayer
 * sends Market.stakeWithAuthorization, paying the gas; no approval is needed. Without it, the
 * person is told they need a little MON and where to get it.
 */
export function GaslessStake({
  m,
  side,
  amount,
  ready,
  onDone,
}: {
  m: MarketView;
  side: Side;
  amount: bigint | null;
  /** True when the stake itself is valid: open market, connected on the right network, amount OK. */
  ready: boolean;
  onDone?: () => void;
}) {
  const wallet = useAppChain();
  const mon = useMonBalance(wallet.address);
  const lowGas = mon.data !== undefined && mon.data < LOW_MON_WEI;
  const relay = useRelayStatus(lowGas);
  const protocol = useProtocolAddresses();
  const relayed = useRelayedStake([
    queryKeys.market(m.address),
    queryKeys.usdc(wallet.address ?? "0x"),
    queryKeys.position(m.address, wallet.address ?? "0x"),
    queryKeys.markets(),
  ]);

  if (!wallet.address || !wallet.onAppChain || (!lowGas && relayed.txs.length === 0)) return null;

  const maxStake = relay.data?.maxStake ? BigInt(relay.data.maxStake) : null;
  const overMax = amount !== null && maxStake !== null && amount > maxStake;
  const sideName = side === Side.Yes ? "YES" : "NO";

  const stake = async () => {
    if (!wallet.address || !protocol.data || amount === null) return;
    const ok = await relayed.stake({
      market: m.address,
      usdc: protocol.data.usdc,
      user: wallet.address,
      side,
      amount,
    });
    if (ok) onDone?.();
  };

  return (
    <div className={s.box}>
      <p className={s.boxTitle}>No MON for gas?</p>
      {relay.data?.enabled ? (
        <>
          <Button
            block
            variant={side === Side.Yes ? "yes" : "no"}
            disabled={!ready || amount === null || overMax || relayed.busy || !protocol.data}
            onClick={() => void stake()}
          >
            {relayed.busy
              ? relayStageText(relayed.stage)
              : amount !== null && ready
                ? `Stake ${formatUsdc(amount)} USDC on ${sideName} without MON`
                : "Stake without MON"}
          </Button>
          <p className={s.note}>
            You sign a USDC authorisation for this market, this side and this amount only. Hunch Book's
            relayer sends it and pays the gas. No approval step.
          </p>
          {overMax && maxStake !== null ? (
            <p className={s.error}>The relayer takes stakes of up to {formatUsdc(maxStake)} USDC.</p>
          ) : null}
        </>
      ) : (
        <GasHelp address={wallet.address} mon={mon.data} />
      )}
      {relayed.error ? (
        <p className={s.error} role="alert">
          {relayed.error}
        </p>
      ) : null}
      <TxList txs={relayed.txs} />
    </div>
  );
}
