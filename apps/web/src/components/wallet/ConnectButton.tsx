"use client";

import { addressUrl } from "@hunch-book/shared";
import { useEffect, useId, useRef, useState } from "react";
import { type Connector, useConnect, useConnectors, useDisconnect } from "wagmi";
import { appChain, appDeployment, appNetworkLabel } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { describeTxError } from "@/lib/wallet/errors";
import { useAppChain } from "@/lib/wallet/useAppChain";
import s from "../layout/layout.module.css";
import { Button } from "../ui";

/**
 * Browser wallets found by EIP-6963, plus the plain injected provider when nothing announced itself.
 * Wagmi lists both, so the generic entry is dropped once a named wallet is present.
 */
export function pickConnectors(connectors: readonly Connector[]): Connector[] {
  const named = connectors.filter((c) => c.id !== "injected");
  return named.length > 0 ? [...named] : [...connectors];
}

function WalletIcon({ connector }: { connector: Connector }) {
  // Wallet icons are data URIs supplied by the wallet itself (EIP-6963).
  return connector.icon ? (
    // biome-ignore lint/performance/noImgElement: tiny data-URI icons from the wallet; next/image adds nothing here
    <img className={s.walletIcon} src={connector.icon} alt="" width={20} height={20} />
  ) : (
    <span className={s.walletIconBlank} aria-hidden="true" />
  );
}

export function ConnectButton() {
  const chain = useAppChain();
  const connectors = pickConnectors(useConnectors());
  const connect = useConnect();
  const disconnect = useDisconnect();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();

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

  // Close the menu once a connection lands.
  useEffect(() => {
    if (chain.isConnected) setOpen(false);
  }, [chain.isConnected]);

  if (chain.isConnected && chain.address) {
    return (
      <div className={s.menuWrap} ref={wrap}>
        {chain.wrongNetwork ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void chain.switchToAppChain()}
            disabled={chain.switching}
          >
            {chain.switching ? "Switching..." : `Switch to ${appNetworkLabel}`}
          </Button>
        ) : (
          <Button size="sm" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}>
            <span className="mono">{shortAddress(chain.address)}</span>
          </Button>
        )}
        {chain.switchError ? (
          <p className={s.menuError} role="alert" style={{ position: "absolute", right: 0, width: 260 }}>
            {chain.switchError}
          </p>
        ) : null}
        {open && !chain.wrongNetwork ? (
          <div className={s.menu} id={menuId}>
            <p className={s.menuHeading}>Connected on {appNetworkLabel}</p>
            <p className={s.addressFull}>{chain.address}</p>
            <a
              className={s.menuItem}
              href={addressUrl(appDeployment, chain.address)}
              target="_blank"
              rel="noreferrer"
            >
              View on explorer
            </a>
            <div className={s.divider} />
            <button type="button" className={s.menuItem} onClick={() => disconnect.mutate()}>
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={s.menuWrap} ref={wrap}>
      <Button
        variant="primary"
        size="sm"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        disabled={chain.isConnecting && !open}
      >
        {chain.isConnecting && !open ? "Connecting..." : "Connect wallet"}
      </Button>
      {open ? (
        <div className={s.menu} id={menuId}>
          <p className={s.menuHeading}>Browser wallets</p>
          {connectors.length === 0 ? (
            <p className={s.menuNote}>
              No browser wallet found. Install{" "}
              <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                MetaMask
              </a>{" "}
              or{" "}
              <a href="https://rabby.io/" target="_blank" rel="noreferrer">
                Rabby
              </a>
              , then reload this page.
            </p>
          ) : (
            connectors.map((connector) => (
              <button
                key={connector.uid}
                type="button"
                className={s.menuItem}
                disabled={connect.isPending}
                onClick={() =>
                  connect.mutate(
                    { connector },
                    {
                      onSuccess: (data) => {
                        if (data.chainId !== appChain.id) void chain.switchToAppChain(connector);
                      },
                    },
                  )
                }
              >
                <WalletIcon connector={connector} />
                <span>{connector.id === "injected" ? "Browser wallet" : connector.name}</span>
              </button>
            ))
          )}
          {connect.error ? (
            <p className={s.menuError} role="alert">
              {describeTxError(connect.error)}
            </p>
          ) : null}
          <p className={s.menuNote}>
            Hunch Book runs on {appNetworkLabel}. After you connect, your wallet asks to add it and switch to
            it.
          </p>
        </div>
      ) : null}
    </div>
  );
}
