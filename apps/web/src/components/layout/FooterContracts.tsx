"use client";

import { addressUrl } from "@hunch-book/shared";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { appDeployment, appNetwork, appNetworkLabel, factoryOf, REPO_URL } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useAppNetwork } from "@/lib/wallet/appNetwork";
import s from "./layout.module.css";

export function ExternalLink({
  href,
  children,
  title,
}: {
  href: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <a className={s.footerLink} href={href} target="_blank" rel="noreferrer" title={title}>
      {children}
      <span className={s.footerArrow} aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

function ContractLink({ name, address }: { name: string; address: Address }) {
  return (
    <ExternalLink href={addressUrl(appDeployment, address)} title={address}>
      {name} <span className={s.footerMono}>{shortAddress(address)}</span>
    </ExternalLink>
  );
}

/** The footer's contract links, for the active network: they follow a switch made in this browser. */
export function FooterContracts() {
  useAppNetwork();
  const factory = factoryOf(appDeployment);
  const { vault, router } = appDeployment.hunchBook;
  return (
    <nav className={s.footerCol} aria-label="Contracts">
      <h2 className={s.footerHeading}>Contracts on {appNetworkLabel}</h2>
      {factory ? (
        <ContractLink name="Factory" address={factory} />
      ) : (
        <span className={s.footerNote}>Factory: not deployed yet</span>
      )}
      {vault ? <ContractLink name="Vault" address={vault} /> : null}
      {router ? <ContractLink name="Router" address={router} /> : null}
      <ExternalLink href={`${REPO_URL}/blob/main/deployments/${appNetwork}.json`}>Every address</ExternalLink>
    </nav>
  );
}
