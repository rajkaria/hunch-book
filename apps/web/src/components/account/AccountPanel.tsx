"use client";

import { useEffect } from "react";
import type { Address } from "viem";
import { LOW_MON_WEI, useAskForGas, useDripState } from "@/lib/account/gas";
import { useIsPasskeyAccount } from "@/lib/account/hooks";
import { appNetwork } from "@/lib/config";
import { formatFixed } from "@/lib/format";
import { useMonBalance } from "@/lib/hooks";
import { useDripStatus } from "@/lib/relayer/hooks";
import { useAppChain } from "@/lib/wallet/useAppChain";
import layout from "../layout/layout.module.css";
import { Badge, Button } from "../ui";
import { MON_FAUCET_URL } from "../wallet/Faucet";
import s from "./account.module.css";

export function formatMon(wei: bigint): string {
  return formatFixed(wei, 18, { minDecimals: 2, maxDecimals: 4 });
}

/** What to do when an account has too little MON: the drip's answer, a button, or the faucet. */
export function GasHelp({ address, mon }: { address: Address; mon: bigint | undefined }) {
  const status = useDripStatus(mon !== undefined && mon < LOW_MON_WEI);
  const state = useDripState(address);
  const ask = useAskForGas();

  if (state?.status === "sent") {
    return (
      <p className={s.ok} role="status">
        The drip sent {state.amountMon ?? "a little"} MON for gas.{" "}
        <a href={state.url} target="_blank" rel="noreferrer">
          View the transaction
        </a>
      </p>
    );
  }
  if (mon === undefined || mon >= LOW_MON_WEI) return null;
  if (state?.status === "pending") {
    return (
      <p className={s.note} role="status">
        Asking the gas drip for a little MON...
      </p>
    );
  }
  const faucet =
    appNetwork === "monad-testnet" ? (
      <a href={MON_FAUCET_URL} target="_blank" rel="noreferrer">
        Get testnet MON from the faucet
      </a>
    ) : (
      <span>Send a little MON to this address from another wallet or an exchange.</span>
    );
  if (state?.status === "refused") {
    return (
      <div className={s.actions}>
        <p className={s.error} role="alert">
          {state.error}
        </p>
        <p className={s.note}>{faucet}</p>
      </div>
    );
  }
  if (status.data?.enabled) {
    return (
      <div className={s.actions}>
        <Button size="sm" block onClick={() => void ask(address)}>
          Get {status.data.amountMon ?? "a little"} MON for gas
        </Button>
        <p className={s.small}>Once per new account, from Hunch Book's gas drip.</p>
      </div>
    );
  }
  return <p className={s.note}>You need a little MON to pay for gas. {faucet}</p>;
}

/**
 * Requests the drip once, by itself, for a passkey account with no MON: such an account is new by
 * construction, and it cannot send its first transaction without gas.
 */
export function AutoDrip() {
  const isPasskey = useIsPasskeyAccount();
  const wallet = useAppChain();
  const mon = useMonBalance(isPasskey ? wallet.address : undefined);
  const empty = isPasskey && wallet.onAppChain && mon.data !== undefined && mon.data < LOW_MON_WEI;
  const status = useDripStatus(empty);
  const state = useDripState(wallet.address);
  const ask = useAskForGas();
  const address = wallet.address;
  const shouldAsk = empty && address !== undefined && status.data?.enabled === true && state === undefined;
  useEffect(() => {
    if (shouldAsk && address) void ask(address);
  }, [shouldAsk, address, ask]);
  return null;
}

/** The account part of the connected menu: which kind of account, its MON, and gas help. */
export function AccountPanel() {
  const isPasskey = useIsPasskeyAccount();
  const wallet = useAppChain();
  const mon = useMonBalance(wallet.address);
  if (!wallet.address) return null;
  return (
    <>
      <p className={layout.menuHeading}>Account</p>
      <div className={s.section}>
        <div className={s.row}>
          <span className={s.kind}>
            {isPasskey ? <Badge tone="violet">Passkey</Badge> : <Badge tone="neutral">Browser wallet</Badge>}
          </span>
          <span className="mono">{mon.data === undefined ? "..." : `${formatMon(mon.data)} MON`}</span>
        </div>
        {isPasskey ? (
          <p className={s.small}>
            Signed in on this tab only. The key is never stored, so a reload asks for your passkey again.
          </p>
        ) : null}
        <GasHelp address={wallet.address} mon={mon.data} />
      </div>
    </>
  );
}
