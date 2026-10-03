"use client";

import { useCallback, useState } from "react";
import { type Connector, useConnection } from "wagmi";
import { appChain, appDeployment } from "../config";
import { describeTxError } from "./errors";
import { addThenSwitch, type Eip1193Like } from "./network";

/** Wallet connection plus whether it is on the app's network, and a way to switch it there. */
export function useAppChain() {
  const connection = useConnection();
  const { connector } = connection;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchToAppChain = useCallback(
    async (target?: Connector) => {
      const active = target ?? connector;
      if (!active) return;
      setPending(true);
      setError(null);
      try {
        const provider = (await active.getProvider()) as Eip1193Like;
        await addThenSwitch(provider, appChain, appDeployment.rpc);
      } catch (e) {
        setError(describeTxError(e));
      } finally {
        setPending(false);
      }
    },
    [connector],
  );

  const isConnected = connection.status === "connected";
  return {
    address: connection.address,
    isConnected,
    isConnecting: connection.status === "connecting" || connection.status === "reconnecting",
    onAppChain: isConnected && connection.chainId === appChain.id,
    wrongNetwork: isConnected && connection.chainId !== appChain.id,
    switchToAppChain,
    switching: pending,
    switchError: error,
  };
}
