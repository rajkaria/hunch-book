import { autoRedeemerAbi } from "@hunch-book/shared";
import { type Abi, type Address, type ContractFunctionParameters, erc20Abi } from "viem";
import { MULTICALL3, type ReadClient } from "../chain/client";
import type { PortfolioEntry } from "../market/types";
import type { RedeemerState } from "./coverage";

type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/** The wallet's opt-in, and for each graduated market its opt-out and its YES and NO allowances. */
export async function readRedeemerState(
  client: ReadClient,
  redeemer: Address,
  user: Address,
  entries: readonly PortfolioEntry[],
): Promise<RedeemerState> {
  const graduated = entries.filter((e) => e.market.graduated);
  const calls = [
    { address: redeemer, abi: autoRedeemerAbi as Abi, functionName: "optedIn", args: [user] },
    ...graduated.flatMap((e) => [
      {
        address: redeemer,
        abi: autoRedeemerAbi as Abi,
        functionName: "optedOut",
        args: [user, e.market.address],
      },
      {
        address: e.market.tokens.yes,
        abi: erc20Abi as Abi,
        functionName: "allowance",
        args: [user, redeemer],
      },
      {
        address: e.market.tokens.no,
        abi: erc20Abi as Abi,
        functionName: "allowance",
        args: [user, redeemer],
      },
    ]),
  ];
  const results = (await client.multicall({
    contracts: calls as unknown as readonly ContractFunctionParameters[],
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })) as Result[];
  const first = results[0];
  if (first?.status !== "success") throw new Error("Could not read your auto-redeem setting.");
  const value = <T>(r: Result | undefined, fallback: T): T =>
    r?.status === "success" ? (r.result as T) : fallback;
  const markets: RedeemerState["markets"] = new Map();
  graduated.forEach((e, i) => {
    const at = 1 + i * 3;
    markets.set(e.market.address.toLowerCase(), {
      optedOut: value(results[at], false),
      allowance: { yes: value(results[at + 1], 0n), no: value(results[at + 2], 0n) },
    });
  });
  return { optedIn: first.result as boolean, markets };
}
