// Live smoke test of the real bot on Monad TESTNET: one full pass of Maker.cycle() over one graduated
// market, with the maker's own key. It discovers the market from the factory, prices it, mints sets on
// the vault, deposits into Kuru's margin account and places a two-sided quote, then checks the orders
// rest on the book. The quotes are left resting. It refuses to run on any chain but testnet.
//
//   pnpm --filter @hunch-book/maker smoke:testnet --market 0x… [--dry-run] [--test-usdc 100]
//                                                 [--deployment-file <path to monad-testnet.json>]
//
// --test-usdc tops the wallet up from Hunch Book's testnet USDC (public mint) when it holds less.
// --deployment-file reads the addresses from another copy of deployments/monad-testnet.json.

import { readFileSync } from "node:fs";
import { type Deployment, loadDeployment } from "@hunch-book/shared";
import { type Address, encodeFunctionData, erc20Abi, formatEther, getAddress, isAddress } from "viem";
import { Maker } from "../src/bot.js";
import { loadEnvFile, parseConfig, REPO_ENV_FILE } from "../src/config.js";
import { findOwnOrders, readL2Book } from "../src/kuru.js";
import { log, setLogSink } from "../src/log.js";
import { sendTx } from "../src/tx.js";

const testUsdcAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function args(argv: string[]) {
  const out: { market?: Address; dryRun: boolean; testUsdc: number; deploymentFile?: string } = {
    dryRun: false,
    testUsdc: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--market" && isAddress(value)) out.market = getAddress(value);
    else if (flag === "--test-usdc") out.testUsdc = Number(value);
    else if (flag === "--deployment-file") out.deploymentFile = value;
    else throw new Error(`unknown argument: ${flag}`);
    i++;
  }
  if (!out.market) throw new Error("--market <address> is required");
  return out as typeof out & { market: Address };
}

async function main(): Promise<void> {
  const opts = args(process.argv.slice(2));
  loadEnvFile(process.env.MAKER_ENV_FILE ?? REPO_ENV_FILE);
  const deployment: Deployment = opts.deploymentFile
    ? (JSON.parse(readFileSync(opts.deploymentFile, "utf8")) as Deployment)
    : loadDeployment("monad-testnet");
  if (deployment.network !== "monad-testnet" || deployment.chainId !== 10143) {
    throw new Error("this smoke test runs on Monad testnet only");
  }
  const config = parseConfig({
    ...process.env,
    MAKER_NETWORK: "monad-testnet",
    MAKER_ENABLED: opts.dryRun ? "0" : "1",
    MAKER_MARKETS: opts.market,
  });
  const txs: Record<string, unknown>[] = [];
  setLogSink((line) => {
    console.log(line);
    const entry = JSON.parse(line);
    if (entry.event === "tx") txs.push(entry);
  });

  const maker = new Maker(config, deployment);
  if ((await maker.client.getChainId()) !== 10143)
    throw new Error("RPC is not Monad testnet: refusing to run");
  maker.checkPublishedAddress();
  const startMon = await maker.client.getBalance({ address: maker.maker });
  log("smoke-start", {
    market: opts.market,
    maker: maker.maker,
    mon: formatEther(startMon),
    dryRun: opts.dryRun,
  });

  const usdc = deployment.hunchBook.usdc;
  if (opts.testUsdc > 0 && usdc) {
    const want = BigInt(Math.round(opts.testUsdc * 1e6));
    const held = await maker.client.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [maker.maker],
    });
    if (held < want) {
      await sendTx(maker.tx, {
        to: usdc,
        data: encodeFunctionData({
          abi: testUsdcAbi,
          functionName: "mint",
          args: [maker.maker, want - held],
        }),
        abi: testUsdcAbi,
        action: "testUsdcMint",
        fields: { amount: want - held },
      });
    }
  }

  await maker.cycle();

  const market = maker.health.current().markets.find((m) => m.market === opts.market);
  if (!market) throw new Error("the market was not quoted: see the log lines above");
  const book = market.book;
  const own = await findOwnOrders(maker.client, book, maker.maker, await readL2Book(maker.client, book));
  const endMon = await maker.client.getBalance({ address: maker.maker });
  log("smoke-done", {
    market: opts.market,
    book,
    status: market.status,
    fair: market.fair,
    resting: own.map((o) => ({ id: o.id, side: o.isBuy ? "bid" : "ask", price: o.price, size: o.remaining })),
    txs: txs.map((t) => ({ action: t.action, status: t.status, hash: t.hash, gasLimit: t.gasLimit })),
    spentMon: formatEther(startMon - endMon),
  });
  if (!opts.dryRun && (!own.some((o) => o.isBuy) || !own.some((o) => !o.isBuy))) {
    throw new Error("expected at least one resting bid and one resting ask");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
