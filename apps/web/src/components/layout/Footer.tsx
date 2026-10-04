import { deployments } from "@hunch-book/shared";
import Link from "next/link";
import { isDeployed, REPO_URL } from "@/lib/config";
import { BUILT_ON, DESCRIPTION } from "@/lib/copy";
import { Badge } from "../ui";
import { BrandTile } from "./Brand";
import { ExternalLink, FooterContracts } from "./FooterContracts";
import s from "./layout.module.css";
import { DOCS_URL, MORE_LINKS, NAV_LINKS } from "./nav";

export function Footer() {
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
              <Link className={s.footerLink} href="/hedge">
                Hedge funding
              </Link>
              <Link className={s.footerLink} href="/status">
                Status
              </Link>
            </nav>
            <FooterContracts />
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
