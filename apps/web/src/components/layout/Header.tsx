import { ConnectButton } from "../wallet/ConnectButton";
import { Brand } from "./Brand";
import s from "./layout.module.css";
import { MobileNav } from "./MobileNav";
import { NavLinks } from "./NavLinks";
import { NetworkSwitch } from "./NetworkSwitch";

export function Header() {
  return (
    <header className={s.header}>
      <div className={s.headerInner}>
        <Brand />
        <NavLinks />
        <div className={s.wallet}>
          <NetworkSwitch />
          <ConnectButton />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
