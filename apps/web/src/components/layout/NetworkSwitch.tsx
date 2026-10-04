"use client";

import type { Network } from "@hunch-book/shared";
import { useEffect, useId, useRef, useState } from "react";
import { useConnection } from "wagmi";
import { DEPLOY_DOCS_URL, NETWORK_LABEL, networkOptions } from "@/lib/config";
import { chooseNetwork, useAppNetwork } from "@/lib/wallet/appNetwork";
import s from "./layout.module.css";
import n from "./network.module.css";

const SHORT: Record<Network, string> = { "monad-testnet": "Testnet", "monad-mainnet": "Mainnet" };

/** The active network's name, for page eyebrows: follows a switch made in this browser. */
export function ActiveNetworkLabel({ suffix }: { suffix?: string }) {
  const network = useAppNetwork();
  return (
    <>
      {NETWORK_LABEL[network]}
      {suffix}
    </>
  );
}

/**
 * Picks the network the app reads from and writes to. A network is offered once its factory is in
 * deployments/<network>.json; until then it reads "planned" and links to how it ships.
 */
export function NetworkSwitch() {
  const active = useAppNetwork();
  const connection = useConnection();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const options = networkOptions();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (network: Network) => {
    setOpen(false);
    if (network === active) return;
    void chooseNetwork(
      network,
      connection.status === "connected"
        ? { connector: connection.connector, chainId: connection.chainId }
        : undefined,
    );
  };

  return (
    <div className={s.menuWrap} ref={wrap}>
      <button
        type="button"
        className={n.trigger}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Network: ${NETWORK_LABEL[active]}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={active === "monad-mainnet" ? n.dotMain : n.dotTest} aria-hidden="true" />
        <span className={n.label}>{SHORT[active]}</span>
        <span className={n.caret} aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className={`${s.menu} ${n.menu}`} id={menuId}>
          <p className={s.menuHeading}>Network</p>
          {options.map((o) =>
            o.selectable ? (
              <button
                key={o.network}
                type="button"
                className={s.menuItem}
                aria-pressed={o.network === active}
                onClick={() => pick(o.network)}
              >
                <span className={o.network === "monad-mainnet" ? n.dotMain : n.dotTest} aria-hidden="true" />
                <span className={n.itemLabel}>{o.label}</span>
                <span className={n.itemState}>
                  {o.network === active ? "selected" : o.deployed ? "live" : "not deployed yet"}
                </span>
              </button>
            ) : (
              <div key={o.network} className={n.planned}>
                <span>{o.network === "monad-mainnet" ? "Mainnet: planned" : `${o.label}: planned`}</span>
                <a href={DEPLOY_DOCS_URL} target="_blank" rel="noreferrer">
                  How it ships
                  <span aria-hidden="true"> ↗</span>
                </a>
              </div>
            ),
          )}
          <p className={s.menuNote}>
            Every read, explorer link and transaction follows the network you pick. This browser remembers it.
          </p>
        </div>
      ) : null}
    </div>
  );
}
