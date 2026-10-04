import { marketAbi } from "@hunch-book/shared";
import { type Abi, type Address, erc20Abi } from "viem";
import { MULTICALL3, type ReadClient } from "../chain/client";
import { readMarketViews } from "../chain/reads";
import type { PortfolioEntry } from "../market/types";

type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/**
 * Portfolio rows for specific markets: the ones in a wallet's history that the portfolio list does not
 * cover (older than the newest markets it reads, or fully exited). Same reads as the portfolio.
 */
export async function readEntries(
  client: ReadClient,
  user: Address,
  addresses: readonly Address[],
): Promise<PortfolioEntry[]> {
  if (addresses.length === 0) return [];
  const markets = await readMarketViews(client, addresses);
  const PER = 5;
  const results = (await client.multicall({
    contracts: markets.flatMap((m) => [
      { address: m.address, abi: marketAbi as Abi, functionName: "stakeOf", args: [user] },
      { address: m.address, abi: marketAbi as Abi, functionName: "claimableTokens", args: [user] },
      { address: m.address, abi: marketAbi as Abi, functionName: "claimablePool", args: [user] },
      { address: m.tokens.yes, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] },
      { address: m.tokens.no, abi: erc20Abi as Abi, functionName: "balanceOf", args: [user] },
    ]) as never,
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })) as Result[];
  const pair = (r: Result | undefined): readonly [bigint, bigint] =>
    r?.status === "success" ? (r.result as readonly [bigint, bigint]) : [0n, 0n];
  const one = (r: Result | undefined): bigint => (r?.status === "success" ? (r.result as bigint) : 0n);
  return markets.map((market, i) => {
    const at = i * PER;
    const stake = pair(results[at]);
    const claimable = pair(results[at + 1]);
    const pool = pair(results[at + 2]);
    return {
      market,
      stake: { yes: stake[0], no: stake[1] },
      claimableTokens: { yes: claimable[0], no: claimable[1] },
      claimablePool: { paid: pool[0], fee: pool[1] },
      balances: { yes: one(results[at + 3]), no: one(results[at + 4]) },
    };
  });
}
