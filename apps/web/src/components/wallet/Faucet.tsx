"use client";

import { testUsdcAbi } from "@hunch-book/shared";
import type { Abi } from "viem";
import { appNetwork } from "@/lib/config";
import { formatUsdc } from "@/lib/format";
import { useTestUsdcFaucet } from "@/lib/hooks";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import { TxList } from "../market/TxList";
import { Button } from "../ui";
import s from "./wallet.module.css";

/** What one faucet press mints: 1,000 test USDC (the contract allows up to 10,000 per call). */
export const FAUCET_AMOUNT = 1_000_000_000n;

/** Monad's own testnet faucet, for MON to pay gas. */
export const MON_FAUCET_URL = "https://faucet.monad.xyz";

/** Below this, tickets offer the faucet. */
export const LOW_USDC = 10_000_000n;

// Every query that shows a USDC balance, by prefix, so one mint refreshes them all.
const USDC_QUERIES = [
  ["usdc", appNetwork],
  ["balances", appNetwork],
  ["portfolio", appNetwork],
];

/** True when the faucet applies: testnet, and the collateral is Hunch Book's own test USDC. */
export function useFaucetAvailable(): boolean {
  return useTestUsdcFaucet().data !== undefined;
}

/**
 * "Get 1,000 test USDC": calls TestUSDC.mint(you, 1,000e6), plus a link to Monad's MON faucet.
 * Testnet only: renders nothing unless the collateral is Hunch Book's own test USDC.
 */
export function FaucetButton({ note, compact }: { note?: string; compact?: boolean }) {
  const faucet = useTestUsdcFaucet();
  const wallet = useAppChain();
  const tx = useTxRunner(USDC_QUERIES);
  if (!faucet.data || !wallet.address) return null;
  const { usdc } = faucet.data;
  const account = wallet.address;
  const mint = () =>
    void tx.run(
      `Get ${formatUsdc(FAUCET_AMOUNT)} test USDC`,
      { address: usdc, abi: testUsdcAbi as Abi, functionName: "mint", args: [account, FAUCET_AMOUNT] },
      account,
    );
  return (
    <div className={s.faucet}>
      {note ? <span className={s.faucetNote}>{note}</span> : null}
      <div className={s.faucetActions}>
        <Button size="sm" variant="primary" onClick={mint} disabled={tx.busy || !wallet.onAppChain}>
          {tx.busy ? stageText(tx.stage) : "Get 1,000 test USDC"}
        </Button>
        <a className={s.faucetLink} href={MON_FAUCET_URL} target="_blank" rel="noreferrer">
          Get testnet MON for gas
        </a>
      </div>
      {!wallet.onAppChain ? (
        <span className={s.small}>Switch your wallet to Monad testnet first.</span>
      ) : null}
      {tx.error ? (
        <span role="alert" className={s.error}>
          {tx.error}
        </span>
      ) : null}
      <TxList txs={tx.txs} />
      {compact ? null : (
        <span className={s.small}>Test USDC is Hunch Book's own testnet token. It has no value.</span>
      )}
    </div>
  );
}

/** Shown on tickets when the wallet holds less USDC than the trade or stake needs, or under 10 USDC. */
export function LowBalanceFaucet({ balance, need }: { balance: bigint | null; need: bigint | null }) {
  const available = useFaucetAvailable();
  if (!available || balance === null) return null;
  const threshold = need !== null && need > LOW_USDC ? need : LOW_USDC;
  if (balance >= threshold) return null;
  return (
    <div className={s.lowBox}>
      <FaucetButton note={`Low on USDC: your wallet holds ${formatUsdc(balance)}.`} compact />
    </div>
  );
}
