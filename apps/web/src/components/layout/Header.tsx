import Link from "next/link";
import { appNetworkLabel } from "@/lib/config";
import { Badge } from "../ui";
import { ConnectButton } from "../wallet/ConnectButton";
import s from "./layout.module.css";
import { NavLinks } from "./NavLinks";

export function Header() {
  return (
    <header className={s.header}>
      <div className={s.headerInner}>
        <Link href="/" className={s.brand} aria-label="Hunch Book home">
          <span className={s.mark} aria-hidden="true" />
          HUNCH BOOK
        </Link>
        <NavLinks />
        <div className={s.wallet}>
          <span className={s.network}>
            <Badge tone="muted" dot>
              {appNetworkLabel}
            </Badge>
          </span>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
