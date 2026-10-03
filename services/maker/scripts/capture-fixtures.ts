// Records live Monad mainnet data into test/fixtures so the pricing tests run on real numbers.
// Read-only: it sends no transaction. Run: pnpm --filter @hunch-book/maker capture-fixtures
//
// What it records, all at one block:
// - Perpl funding sums at the last 600 funding-grid blocks for BTC and MON (getFundingSumAtBlock)
// - the last 300 Chainlink rounds for BTC/USD, ETH/USD and MON/USD (getRoundData walk-back)
// - Kuru's MON-USDC book: getL2Book bytes, bestBidAsk and getMarketParams

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainsByNetwork, kuruOrderBookAbi, loadDeployment } from "@hunch-book/shared";
import { type Address, createPublicClient, getAddress, http, type PublicClient } from "viem";
import { loadEnvFile, REPO_ENV_FILE } from "../src/config.js";
import { readChainlinkHistory, readFundingHistory, readPerpInfo } from "../src/pricing/sources.js";

const FUNDING_INTERVALS = 600;
const CHAINLINK_ROUNDS = 300;
/** Kuru's own MON-USDC market on mainnet. */
const KURU_MON_USDC = getAddress("0x065C9d28E428A0db40191a54d33d5b7c71a9C394");

const out = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const json = (value: unknown) =>
  `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;

function write(name: string, value: unknown): void {
  writeFileSync(`${out}${name}`, json(value));
  console.log(`wrote test/fixtures/${name}`);
}

async function main(): Promise<void> {
  loadEnvFile(process.env.MAKER_ENV_FILE ?? REPO_ENV_FILE);
  const deployment = loadDeployment("monad-mainnet");
  const rpc = process.env.MONAD_MAINNET_RPC || deployment.rpc;
  const client = createPublicClient({
    chain: chainsByNetwork["monad-mainnet"],
    transport: http(rpc, { retryCount: 3, timeout: 30_000 }),
  }) as PublicClient;
  mkdirSync(out, { recursive: true });

  const block = await client.getBlock();
  const at = Number(block.number);
  const source = {
    network: deployment.network,
    chainId: deployment.chainId,
    block: at,
    blockTimestamp: Number(block.timestamp),
    capturedAt: new Date().toISOString(),
  };

  const exchange = deployment.external.perpl.exchange;
  for (const asset of ["BTC", "MON"]) {
    const perpId = BigInt(deployment.external.perpl.perps[asset] as number);
    const [info, history] = await Promise.all([
      readPerpInfo(client, exchange, perpId),
      readFundingHistory(client, exchange, perpId, at, FUNDING_INTERVALS),
    ]);
    write(`perpl-funding-${asset.toLowerCase()}.json`, {
      source: { ...source, contract: exchange, method: "getFundingSumAtBlock(perpId, block)" },
      perpId: Number(perpId),
      perp: info,
      interval: history.interval,
      lastEvent: history.lastEvent,
      samples: history.samples,
    });
  }

  for (const [pair, feed] of Object.entries(deployment.external.chainlink)) {
    const history = await readChainlinkHistory(client, feed as Address, CHAINLINK_ROUNDS);
    write(`chainlink-${pair.toLowerCase().replace("/", "-")}.json`, {
      source: { ...source, contract: feed, method: "latestRoundData, then getRoundData walking back" },
      pair,
      decimals: history.decimals,
      description: history.description,
      rounds: history.rounds,
    });
  }

  const blockNumber = block.number;
  const [l2, bestBidAsk, params] = await Promise.all([
    client.readContract({
      address: KURU_MON_USDC,
      abi: kuruOrderBookAbi,
      functionName: "getL2Book",
      blockNumber,
    }),
    client.readContract({
      address: KURU_MON_USDC,
      abi: kuruOrderBookAbi,
      functionName: "bestBidAsk",
      blockNumber,
    }),
    client.readContract({
      address: KURU_MON_USDC,
      abi: kuruOrderBookAbi,
      functionName: "getMarketParams",
      blockNumber,
    }),
  ]);
  write("kuru-l2-mon-usdc.json", {
    source: { ...source, contract: KURU_MON_USDC, method: "getL2Book(), bestBidAsk(), getMarketParams()" },
    l2,
    bestBidAsk,
    pricePrecision: params[0],
    sizePrecision: params[1],
    tickSize: params[6],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
