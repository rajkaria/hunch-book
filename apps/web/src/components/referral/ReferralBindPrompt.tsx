"use client";

import { referralRegistryAbi } from "@hunch-book/shared";
import { useEffect } from "react";
import { type Abi, isAddressEqual } from "viem";
import { peripheryMessage } from "@/lib/periphery";
import { referralKeys, referralRegistryAddress, useBinding, useStoredReferrer } from "@/lib/referral/hooks";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { stageText, useTxRunner } from "@/lib/wallet/useTxRunner";
import { TxList } from "../market/TxList";
import { AddressLink, Button, Notice } from "../ui";
import s from "./referral.module.css";

/**
 * Offers to bind the referrer this browser remembers (from a /r/ link) the first time a connected wallet is
 * about to act. Shows nothing without a remembered referrer, after "No thanks", for the referrer's own
 * wallet, or once the wallet is bound.
 */
export function ReferralBindPrompt() {
  const registry = referralRegistryAddress();
  const wallet = useAppChain();
  const { stored, dismiss, clear } = useStoredReferrer();
  const binding = useBinding(wallet.address);
  const tx = useTxRunner(wallet.address ? [referralKeys.binding(wallet.address)] : []);

  const referrer = stored?.referrer;
  const self = Boolean(referrer && wallet.address && isAddressEqual(referrer, wallet.address));
  const boundToIt = Boolean(
    referrer && binding.data?.active && isAddressEqual(binding.data.referrer, referrer),
  );

  // Once the wallet is bound to the remembered referrer, there is nothing left to remember.
  useEffect(() => {
    if (boundToIt) clear();
  }, [boundToIt, clear]);

  if (!registry || !referrer || !stored || stored.dismissed || self) return null;
  if (!wallet.isConnected || !wallet.address || !wallet.onAppChain) return null;
  if (!binding.data || binding.data.active) return tx.txs.length > 0 ? <TxList txs={tx.txs} /> : null;

  const account = wallet.address;
  const bind = () =>
    void tx.run(
      "Bind your referrer",
      { address: registry, abi: referralRegistryAbi as Abi, functionName: "bind", args: [referrer] },
      account,
    );

  return (
    <Notice tone="accent" title="You came from a referral link">
      <p>
        <AddressLink address={referrer} /> shared the link you opened. Bind them as your referrer for 180
        days? It costs you nothing: their share comes out of the protocol's part of the fees, never out of
        your stakes or winnings.
      </p>
      <div className={s.row}>
        <Button size="sm" variant="primary" onClick={bind} loading={tx.busy}>
          {tx.busy ? stageText(tx.stage) : "Bind referrer"}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss} disabled={tx.busy}>
          No thanks
        </Button>
      </div>
      {tx.error ? (
        <p className={s.error} role="alert">
          {peripheryMessage(tx.error)}
        </p>
      ) : null}
      <TxList txs={tx.txs} />
    </Notice>
  );
}
