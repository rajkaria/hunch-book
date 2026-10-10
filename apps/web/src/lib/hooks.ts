"use client";

import { testUsdcAbi } from "@hunch-book/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { getPublicClient, makePublicClient } from "./chain/client";
import { readBookSnapshot } from "./chain/kuru";
import {
  listMarkets,
  measureMsPerBlock,
  readChainHead,
  readMarket,
  readPortfolio,
  readProtocolAddresses,
  readUsdcState,
  readUserPosition,
  readWalletBalances,
} from "./chain/reads";
import { appChain, appDeployment, appNetwork, isDeployed, usdcOf } from "./config";
import { planSettlement } from "./market/settle";
import type { ChainClock, MarketView } from "./market/types";
import { defaultStack, deployBlockOf, routerOf } from "./stacks";
import { findSettlementTx, runVerification } from "./verify/read";

// React Query hooks over the read layer. Query keys never hold bigints.

/** Read on every render, so a network switch in the browser turns the queries on or off. */
const deployed = (): boolean => isDeployed(appDeployment);

export const queryKeys = {
  markets: () => ["markets", appNetwork] as const,
  market: (address: Address) => ["market", appNetwork, address.toLowerCase()] as const,
  portfolio: (user: Address) => ["portfolio", appNetwork, user.toLowerCase()] as const,
  position: (market: Address, user: Address) =>
    ["position", appNetwork, market.toLowerCase(), user.toLowerCase()] as const,
  head: () => ["head", appNetwork] as const,
  blockTime: () => ["block-time", appNetwork] as const,
  protocol: () => ["protocol", appNetwork] as const,
  usdc: (user: Address) => ["usdc", appNetwork, user.toLowerCase()] as const,
  book: (book: Address) => ["book", appNetwork, book.toLowerCase()] as const,
  balances: (market: Address, user: Address) =>
    ["balances", appNetwork, market.toLowerCase(), user.toLowerCase()] as const,
  settlePlan: (market: Address) => ["settle-plan", appNetwork, market.toLowerCase()] as const,
  verification: (market: Address) => ["verification", appNetwork, market.toLowerCase()] as const,
  settlementTx: (market: Address) => ["settlement-tx", appNetwork, market.toLowerCase()] as const,
  faucet: () => ["faucet", appNetwork] as const,
  mon: (user: Address) => ["mon", appNetwork, user.toLowerCase()] as const,
};

/** Every query a wallet's transaction can change for one market, to refresh after it lands. */
export function walletQueryKeys(market: MarketView, user: Address | undefined) {
  const u = user ?? "0x";
  return [
    queryKeys.market(market.address),
    queryKeys.markets(),
    queryKeys.usdc(u),
    queryKeys.position(market.address, u),
    queryKeys.portfolio(u),
    queryKeys.balances(market.address, u),
    queryKeys.settlePlan(market.address),
    queryKeys.mon(u),
    ...(market.book ? [queryKeys.book(market.book)] : []),
  ];
}

export function useMarkets() {
  return useQuery({
    queryKey: queryKeys.markets(),
    queryFn: () => listMarkets(getPublicClient(), appDeployment),
    enabled: deployed(),
    refetchInterval: 15_000,
  });
}

export function useMarket(address: Address) {
  return useQuery({
    queryKey: queryKeys.market(address),
    queryFn: () => readMarket(getPublicClient(), appDeployment, address),
    enabled: deployed(),
    refetchInterval: 6_000,
  });
}

export function usePortfolio(user: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.portfolio(user ?? "0x"),
    queryFn: () => readPortfolio(getPublicClient(), appDeployment, user as Address),
    enabled: deployed() && Boolean(user),
    refetchInterval: 15_000,
  });
}

export function useUserPosition(market: Address, user: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.position(market, user ?? "0x"),
    queryFn: () => readUserPosition(getPublicClient(), market, user as Address),
    enabled: deployed() && Boolean(user),
    refetchInterval: 10_000,
  });
}

/** The vault and USDC of `market`'s stack (the primary stack when no market is given). */
export function useProtocolAddresses(market?: Pick<MarketView, "stack">) {
  const stack = market?.stack ?? "primary";
  return useQuery({
    queryKey: [...queryKeys.protocol(), stack],
    queryFn: () => readProtocolAddresses(getPublicClient(), appDeployment, stack),
    enabled: deployed(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The wallet's USDC balance and its allowance to `protocol.vault`. Each stack has its own vault, so the
 * vault is part of the key (queryKeys.usdc(user) still refreshes every one of them).
 */
export function useUsdcState(
  user: Address | undefined,
  protocol: { vault: Address; usdc: Address } | null | undefined,
) {
  return useQuery({
    queryKey: [...queryKeys.usdc(user ?? "0x"), protocol?.vault.toLowerCase() ?? "none"],
    queryFn: () =>
      readUsdcState(
        getPublicClient(),
        protocol?.usdc as Address,
        protocol?.vault as Address,
        user as Address,
      ),
    enabled: Boolean(user && protocol),
    refetchInterval: 10_000,
  });
}

/** The chain head (every 5 seconds) plus the measured block time (once), for block-clock markets. */
export function useChainClock(enabled = true): ChainClock | null {
  const head = useQuery({
    queryKey: queryKeys.head(),
    queryFn: () => readChainHead(getPublicClient()),
    enabled,
    refetchInterval: 5_000,
  });
  const blockNumber = head.data?.blockNumber;
  const pace = useQuery({
    queryKey: queryKeys.blockTime(),
    queryFn: () => measureMsPerBlock(getPublicClient(), blockNumber as bigint),
    enabled: enabled && blockNumber !== undefined,
    staleTime: 10 * 60_000,
  });
  if (!head.data) return null;
  const measured = typeof pace.data === "number";
  return {
    blockNumber: head.data.blockNumber,
    timestamp: head.data.timestamp,
    msPerBlock: measured ? (pace.data as number) : (appChain.blockTime ?? 400),
    measured,
  };
}

/** Unix seconds, ticking. Null until the component mounts, so server and client HTML match. */
export function useNow(intervalMs = 1_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * A graduated market's book: levels, params and our maker's share of each level (Kuru v1's interface:
 * Kuru's v1 books and Hunch Book's own). `kuruVersion` is the market's (MarketView.kuruVersion; absent
 * = 1).
 */
export function useBook(book: Address | null, kuruVersion: 1 | 2 = 1) {
  return useQuery({
    queryKey: queryKeys.book(book ?? "0x"),
    queryFn: () =>
      readBookSnapshot(getPublicClient(), book as Address, appDeployment.wallets.maker, kuruVersion),
    enabled: deployed() && book !== null,
    refetchInterval: 5_000,
  });
}

/** The wallet's USDC, YES and NO for one market, and its allowances to the router and the vault. */
export function useWalletBalances(user: Address | undefined, market: MarketView) {
  const protocol = useProtocolAddresses(market);
  return useQuery({
    queryKey: queryKeys.balances(market.address, user ?? "0x"),
    queryFn: () =>
      readWalletBalances(
        getPublicClient(),
        {
          usdc: protocol.data?.usdc as Address,
          vault: protocol.data?.vault as Address,
          router: routerOf(market),
          yes: market.tokens.yes,
          no: market.tokens.no,
        },
        user as Address,
      ),
    enabled: deployed() && Boolean(user && protocol.data),
    refetchInterval: 10_000,
  });
}

/** The wallet's MON, for gas. */
export function useMonBalance(user: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.mon(user ?? "0x"),
    queryFn: () => getPublicClient().getBalance({ address: user as Address }),
    enabled: Boolean(user),
    refetchInterval: 20_000,
  });
}

/** The evidence that settles this market now, found and dry-run from the browser. */
export function useSettlePlan(market: MarketView, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.settlePlan(market.address),
    queryFn: () => planSettlement(getPublicClient(), market),
    enabled: deployed() && enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * The settlement verifier's reads. Each run uses a fresh public client over the deployment's RPC, with
 * no wallet and no cache, so a re-run really asks the chain again.
 */
export function useVerification(market: MarketView) {
  return useQuery({
    // The phase is part of the key, so the read runs again once the market settles.
    queryKey: [...queryKeys.verification(market.address), market.phase],
    queryFn: async () => {
      const client = makePublicClient();
      const head = await client.getBlockNumber();
      return runVerification(client, appDeployment, market, head);
    },
    enabled: deployed(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** Where a settled or voided market settled: block, transaction and settler. */
export function useSettlementTx(market: MarketView, final: boolean) {
  return useQuery({
    queryKey: queryKeys.settlementTx(market.address),
    queryFn: async () => {
      const client = getPublicClient();
      const head = await client.getBlockNumber();
      const from = market.window.blockClock ? market.window.close : deployBlockOf(market);
      return findSettlementTx(client, market, from, head);
    },
    enabled: deployed() && final,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * Hunch Book's own test USDC with a public faucet: testnet only, the token deployed with the protocol
 * (the collateral of the stack new markets go to), and it answers FAUCET_LIMIT(). Resolves to the token
 * and its limit per request.
 */
export function useTestUsdcFaucet() {
  const own = defaultStack()?.contracts.usdc ?? appDeployment.hunchBook.usdc;
  const usdc = own ?? usdcOf(appDeployment);
  const candidate = appNetwork === "monad-testnet" && Boolean(own) && Boolean(usdc);
  return useQuery({
    queryKey: queryKeys.faucet(),
    queryFn: async () => {
      const limit = await getPublicClient().readContract({
        address: usdc as Address,
        abi: testUsdcAbi,
        functionName: "FAUCET_LIMIT",
      });
      return { usdc: usdc as Address, limit };
    },
    enabled: candidate,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}
