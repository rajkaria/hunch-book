// Records live Monad mainnet data into test/fixtures so the pricing tests run on real numbers.
// Read-only: it sends no transaction. Run: pnpm --filter @hunch-book/maker capture-fixtures
//   [--only name,name]  record only these fixtures (default: all of them)
//
// What it records, all at one block:
// - perpl-funding-{btc,mon}: Perpl funding sums at the last 600 funding-grid blocks (getFundingSumAtBlock)
// - chainlink-{btc,eth,mon,sol}-usd: the last 300 Chainlink rounds (getRoundData walk-back)
// - kuru-l2-mon-usdc: Kuru's MON-USDC book (getL2Book bytes, bestBidAsk, getMarketParams)
// - kuru-trades-mon-usdc: Kuru's MON-USDC Trade events walking back from the head until at least 60
//   are found (or 30,000 blocks), with the book as it stood at the first block read, for paper mode

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainsByNetwork, kuruOrderBookAbi, loadDeployment } from "@hunch-book/shared";
import { type Address, createPublicClient, getAbiItem, getAddress, http, type PublicClient } from "viem";
import { loadEnvFile, REPO_ENV_FILE } from "../src/config.js";
import { readChainlinkHistory, readFundingHistory, readPerpInfo } from "../src/pricing/sources.js";

const FUNDING_INTERVALS = 600;
const CHAINLINK_ROUNDS = 300;
/** Kuru's own MON-USDC market on mainnet. */
const KURU_MON_USDC = getAddress("0x065C9d28E428A0db40191a54d33d5b7c71a9C394");
const TRADES_WANTED = 60;
const TRADES_MAX_BLOCKS = 30_000n;
const LOG_RANGE = 100n;

const out = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const json = (value: unknown) =>
  `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;

function write(name: string, value: unknown): void {
  writeFileSync(`${out}${name}`, json(value));
  console.log(`wrote test/fixtures/${name}`);
}

function only(argv: string[]): Set<string> | undefined {
  const i = argv.indexOf("--only");
  if (i === -1) return undefined;
  return new Set(
    (argv[i + 1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\.json$/, ""))
      .filter(Boolean),
  );
}

async function main(): Promise<void> {
  loadEnvFile(process.env.MAKER_ENV_FILE ?? REPO_ENV_FILE);
  const wanted = only(process.argv.slice(2));
  const want = (name: string) => !wanted || wanted.has(name);
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
    const name = `perpl-funding-${asset.toLowerCase()}`;
    if (!want(name)) continue;
    const perpId = BigInt(deployment.external.perpl.perps[asset] as number);
    const [info, history] = await Promise.all([
      readPerpInfo(client, exchange, perpId),
      readFundingHistory(client, exchange, perpId, at, FUNDING_INTERVALS),
    ]);
    write(`${name}.json`, {
      source: { ...source, contract: exchange, method: "getFundingSumAtBlock(perpId, block)" },
      perpId: Number(perpId),
      perp: info,
      interval: history.interval,
      lastEvent: history.lastEvent,
      samples: history.samples,
    });
  }

  for (const [pair, feed] of Object.entries(deployment.external.chainlink)) {
    const name = `chainlink-${pair.toLowerCase().replace("/", "-")}`;
    if (!want(name)) continue;
    const history = await readChainlinkHistory(client, feed as Address, CHAINLINK_ROUNDS);
    write(`${name}.json`, {
      source: { ...source, contract: feed, method: "latestRoundData, then getRoundData walking back" },
      pair,
      decimals: history.decimals,
      description: history.description,
      rounds: history.rounds,
    });
  }

  const blockNumber = block.number;
  if (want("kuru-l2-mon-usdc")) {
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

  if (want("kuru-trades-mon-usdc")) {
    const event = getAbiItem({ abi: kuruOrderBookAbi, name: "Trade" });
    const trades: Record<string, unknown>[] = [];
    let to = blockNumber;
    let from = to;
    while (trades.length < TRADES_WANTED && blockNumber - to < TRADES_MAX_BLOCKS) {
      from = to - LOG_RANGE + 1n;
      const logs = await client.getLogs({ address: KURU_MON_USDC, event, fromBlock: from, toBlock: to });
      trades.unshift(
        ...logs.map((l) => ({
          block: l.blockNumber,
          logIndex: l.logIndex,
          tx: l.transactionHash,
          orderId: l.args.orderId,
          maker: l.args.makerAddress,
          takerBuysYes: l.args.isBuy,
          priceE18: l.args.price,
          filledSize: l.args.filledSize,
          makerRemaining: l.args.updatedSize,
        })),
      );
      to = from - 1n;
    }
    // The book just before the first block read, so a test can quote around the mid of that moment.
    const before = from - 1n;
    const [l2, bestBidAsk, params] = await Promise.all([
      client.readContract({
        address: KURU_MON_USDC,
        abi: kuruOrderBookAbi,
        functionName: "getL2Book",
        blockNumber: before,
      }),
      client.readContract({
        address: KURU_MON_USDC,
        abi: kuruOrderBookAbi,
        functionName: "bestBidAsk",
        blockNumber: before,
      }),
      client.readContract({
        address: KURU_MON_USDC,
        abi: kuruOrderBookAbi,
        functionName: "getMarketParams",
        blockNumber: before,
      }),
    ]);
    write("kuru-trades-mon-usdc.json", {
      source: {
        ...source,
        contract: KURU_MON_USDC,
        method: "Trade events (eth_getLogs, 100-block windows), and the book at fromBlock - 1",
        fromBlock: from,
        toBlock: blockNumber,
      },
      bookAt: before,
      l2,
      bestBidAsk,
      pricePrecision: params[0],
      sizePrecision: params[1],
      baseDecimals: params[3],
      quoteDecimals: params[5],
      tickSize: params[6],
      minSize: params[7],
      trades,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
