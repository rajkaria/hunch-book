"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useConnection } from "wagmi";
import { PASSKEY_CONNECTOR_TYPE } from "./connector";
import { type PasskeySupport, passkeySupport } from "./passkey";
import { activePasskey, subscribePasskey } from "./session";

/** The live passkey session in this tab, or null. */
export function usePasskeySession() {
  return useSyncExternalStore(subscribePasskey, activePasskey, () => null);
}

/** True when the connected account is a passkey account. */
export function useIsPasskeyAccount(): boolean {
  const { connector, status } = useConnection();
  return status === "connected" && connector?.type === PASSKEY_CONNECTOR_TYPE;
}

/** Whether this browser and page can make passkey accounts. Null until checked (after mount). */
export function usePasskeySupport(): PasskeySupport | null {
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  useEffect(() => {
    let live = true;
    void passkeySupport().then((s) => {
      if (live) setSupport(s);
    });
    return () => {
      live = false;
    };
  }, []);
  return support;
}
