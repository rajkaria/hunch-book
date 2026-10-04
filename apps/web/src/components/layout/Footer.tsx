import { addressUrl, deployments } from "@hunch-book/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { appDeployment, appNetwork, appNetworkLabel, factoryOf, isDeployed, REPO_URL } from "@/lib/config";
import { BUILT_ON, DESCRIPTION } from "@/lib/copy";
import { shortAddress } from "@/lib/format";
import { Badge } from "../ui";
import { BrandTile } from "./Brand";
import s from "./layout.module.css";
import { DOCS_URL, MORE_LINKS, NAV_LINKS } from "./nav";

function ExternalLink({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
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

export function Footer() {
  const factory = factoryOf(appDeployment);
  const { vault, router } = appDeployment.hunchBook;
  const testnetLive = isDeployed(deployments["monad-testnet"]);
  const mainnetLive = isDeployed(deployments["monad-mainnet"]);
  return (
    <footer className={s.footer}>
      <div className={s.footerInner}>
        <div className={s.footerTop}>
          <div className={s.footerBrand}>
            <Link href="/" className={s.footerHome} aria-label="Hunch Book, home">
              <BrandTile size={30} />
              <span className={s.wordmark}>
                Hunch <span className={s.wordmarkBook}>Book</span>
              </span>
            </Link>
            <p className={s.footerLede}>{DESCRIPTION}</p>
            <div className={s.footerStatus}>
              <Badge tone={testnetLive ? "accent" : "muted"} dot>
                Monad testnet: {testnetLive ? "live" : "building"}
              </Badge>
              <Badge tone="muted" dot>
                Monad mainnet: {mainnetLive ? "live" : "planned"}
              </Badge>
            </div>
          </div>

          <div className={s.footerCols}>
            <nav className={s.footerCol} aria-label="Product">
              <h2 className={s.footerHeading}>Product</h2>
              {[...NAV_LINKS, ...MORE_LINKS].map((link) => (
                <Link key={link.href} className={s.footerLink} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </nav>
            <nav className={s.footerCol} aria-label="Contracts">
              <h2 className={s.footerHeading}>Contracts on {appNetworkLabel}</h2>
              {factory ? (
                <ContractLink name="Factory" address={factory} />
              ) : (
                <span className={s.footerNote}>Factory: not deployed yet</span>
              )}
              {vault ? <ContractLink name="Vault" address={vault} /> : null}
              {router ? <ContractLink name="Router" address={router} /> : null}
              <ExternalLink href={`${REPO_URL}/blob/main/deployments/${appNetwork}.json`}>
                Every address
              </ExternalLink>
            </nav>
            <nav className={s.footerCol} aria-label="Docs">
              <h2 className={s.footerHeading}>Docs</h2>
              <ExternalLink href={DOCS_URL}>Protocol</ExternalLink>
              <ExternalLink href={`${REPO_URL}/blob/main/docs/ROADMAP.md`}>Roadmap</ExternalLink>
              <ExternalLink href={`${REPO_URL}/blob/main/SECURITY.md`}>Security</ExternalLink>
              <ExternalLink href={`${REPO_URL}/tree/main/services/maker`}>Maker bot</ExternalLink>
              <ExternalLink href={REPO_URL}>Source on GitHub</ExternalLink>
            </nav>
          </div>
        </div>

        <div className={s.footerBottom}>
          <p>{BUILT_ON}</p>
          <p>
            <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
              MIT licensed
            </a>
            <span aria-hidden="true"> · </span>
            <a href="https://playhunch.xyz" target="_blank" rel="noreferrer">
              More from Hunch
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
