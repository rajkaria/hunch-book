"use client";

import { hunchBookFactoryAbi, type Side } from "@hunch-book/shared";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type Address, type Hex, isAddressEqual, type Log, parseEventLogs } from "viem";
import { useWriteContract } from "wagmi";
import { getPublicClient } from "../chain/client";
import { appChain } from "../config";
import type { TxRecord } from "../wallet/useTxRunner";
import { createMarketAbi } from "./abis";
import { describeCreateError } from "./errors";
import { readMarketOf } from "./reads";

/** The new market's address from the factory's MarketCreated event in a receipt's logs, or null. */
export function marketFromLogs(logs: readonly Log[], factory: Address): Address | null {
  const events = parseEventLogs({ abi: hunchBookFactoryAbi, eventName: "MarketCreated", logs: [...logs] });
  const mine = events.find((e) => isAddressEqual(e.address, factory));
  return mine ? mine.args.market : null;
}

export interface CreateRequest {
  factory: Address;
  templateId: number;
  params: Hex;
  side: Side;
  amount: bigint;
  /** marketKey(templateId, params), for the fallback lookup. */
  key: Hex;
  account: Address;
}

export interface Created {
  market: Address;
  hash: Hex;
}

/**
 * Sends `createMarket`: simulate first (a revert reads in plain words before the wallet opens), ask
 * the wallet, wait for the receipt, then read the new market's address from the MarketCreated event
 * (or, failing that, from `marketOf(key)`).
 */
export function useCreateMarket(refresh: QueryKey[]) {
  const write = useWriteContract();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<"idle" | "simulate" | "wallet" | "block">("idle");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<TxRecord | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const run = useCallback(
    async (r: CreateRequest): Promise<Created | null> => {
      setError(null);
      setStage("simulate");
      const client = getPublicClient();
      const request = {
        address: r.factory,
        abi: createMarketAbi,
        functionName: "createMarket",
        args: [r.templateId, r.params, r.side, r.amount],
      } as const;
      try {
        await client.simulateContract({ ...request, account: r.account });
        setStage("wallet");
        // The request shape is checked by the simulation above; wagmi's generics cannot follow a merged ABI.
        const hash = await write.mutateAsync({ ...request, chainId: appChain.id } as never);
        setTx({ hash, label: "Create the market and make the first stake", status: "pending" });
        setStage("block");
        const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
        if (receipt.status !== "success") {
          setTx({ hash, label: "Create the market and make the first stake", status: "failed" });
          setError("The transaction reverted on chain. Nothing was moved.");
          return null;
        }
        setTx({ hash, label: "Create the market and make the first stake", status: "confirmed" });
        const market =
          marketFromLogs(receipt.logs, r.factory) ?? (await readMarketOf(client, r.factory, r.key));
        if (!market) {
          setError("The market was created, but its address could not be read. Find it on the markets page.");
          return null;
        }
        const done = { market, hash };
        setCreated(done);
        return done;
      } catch (e) {
        setError(describeCreateError(e));
        return null;
      } finally {
        setStage("idle");
        await Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      }
    },
    [write, queryClient, refresh],
  );

  return { run, stage, busy: stage !== "idle", error, tx, created };
}
