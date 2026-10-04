"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type Address, isAddressEqual } from "viem";
import { appNetworkLabel, REPO_URL } from "@/lib/config";
import { formatUtc } from "@/lib/format";
import { referralRegistryAddress, useBinding, useStoredReferrer } from "@/lib/referral/hooks";
import type { SaveResult } from "@/lib/referral/storage";
import { useAppChain } from "@/lib/wallet/useAppChain";
import { AddressLink, ButtonLink, Notice, Panel } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import { ReferralBindPrompt } from "./ReferralBindPrompt";
import s from "./referral.module.css";

export const REFERRAL_DOCS_URL = `${REPO_URL}/blob/main/docs/PERIPHERY.md#referralregistry`;

/**
 * The /r/<referrer> landing: remembers the referrer in this browser (nothing is sent), explains what a
 * referral is, and offers to bind it once a wallet is connected. Then it sends the visitor on to `next`.
 */
export function ReferralLanding({ referrer, next }: { referrer: Address; next: string | null }) {
  const registry = referralRegistryAddress();
  const wallet = useAppChain();
  const { save } = useStoredReferrer();
  const binding = useBinding(wallet.address);
  const [result, setResult] = useState<SaveResult | null>(null);

  // Remember the referrer once on arrival, and again if a wallet connects (to catch a self-referral).
  useEffect(() => {
    if (!registry) return;
    setResult(save(referrer, wallet.address));
  }, [registry, referrer, wallet.address, save]);

  const self = Boolean(wallet.address && isAddressEqual(wallet.address, referrer));
  const bound = binding.data?.active ? binding.data : null;
  const continueHref = next ?? "/markets";

  return (
    <div className={s.landing}>
      <Panel variant="glass">
        <div className={s.landingHead}>
          <p className="eyebrow">Referral link</p>
          <h2 className={s.landingTitle}>
            Shared by <AddressLink address={referrer} />
          </h2>
        </div>

        {!registry ? (
          <Notice tone="warn" title="Referrals are not deployed here yet">
            The referral registry is not deployed on {appNetworkLabel}, so this link is not remembered. You
            can still use the app.
          </Notice>
        ) : self ? (
          <Notice tone="warn" title="This is your own link">
            Share it with others: a wallet cannot be its own referrer.
          </Notice>
        ) : bound ? (
          <Notice title="Your wallet already has a referrer">
            It is bound to <AddressLink address={bound.referrer} /> until {formatUtc(bound.expiresAt)}. A
            binding cannot change while it is active.
          </Notice>
        ) : result === "unavailable" ? (
          <Notice tone="warn" title="This browser blocks storage">
            The link could not be remembered here. Connect a wallet now to bind the referrer directly.
          </Notice>
        ) : (
          <p className={s.saved} role="status">
            Remembered in this browser. When you connect a wallet and take your first action, you can bind{" "}
            <AddressLink address={referrer} /> as your referrer, or say no.
          </p>
        )}

        <ul className={s.facts}>
          <li>
            A binding lasts 180 days and is recorded onchain by the ReferralRegistry. Nobody else can make or
            change it.
          </li>
          <li>
            It costs you nothing. Your referrer earns a share of the protocol's part of the fees you pay, paid
            by the protocol, never out of your stakes or winnings.
          </li>
          <li>Binding is a transaction you choose to send. Ignore it and nothing happens.</li>
        </ul>

        {registry && !self && !bound ? (
          wallet.onAppChain ? (
            <ReferralBindPrompt />
          ) : (
            <div className={s.row}>
              <ConnectButton />
            </div>
          )
        ) : null}

        <div className={s.row}>
          <ButtonLink href={continueHref} variant="primary" arrow>
            {next ? "Continue" : "Browse markets"}
          </ButtonLink>
          <Link href="/feed">Swipe the feed</Link>
          <a href={REFERRAL_DOCS_URL} target="_blank" rel="noreferrer">
            How referrals work
          </a>
        </div>
      </Panel>
    </div>
  );
}
