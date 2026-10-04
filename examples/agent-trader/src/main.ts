import {
  createHunchClient,
  describeError,
  formatUsdc,
  fundingAt,
  fundingInterval,
  type HunchClient,
  type MarketInfo,
  monadMainnet,
  monadTestnet,
  type Network,
  Phase,
  parseUsdc,
  resolverExchange,
} from "@hunch-book/sdk";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decide, estimateYes, fillStillWorthIt } from "./strategy.js";

// A small agent on @hunch-book/sdk. Every minute it reads each trading Perpl funding market (template
// 1), estimates the chance that funding ends above the threshold from Perpl's own history, and buys YES
// when the book's ask is cheap enough, within a budget. It only prints what it would do unless
// AGENT_LIVE=1 and AGENT_PRIVATE_KEY are set.

interface Settings {
  network: Network;
  live: boolean;
  budget: number;
  maxTrade: number;
  minEdge: number;
  slippageBps: bigint;
  intervalSeconds: number;
  once: boolean;
}

function settings(env: NodeJS.ProcessEnv, argv: string[]): Settings {
  const num = (name: string, fallback: number): number => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number`);
    return n;
  };
  const network = (env.AGENT_NETWORK ?? "monad-testnet") as Network;
  if (network !== "monad-testnet" && network !== "monad-mainnet")
    throw new Error("AGENT_NETWORK must be monad-testnet or monad-mainnet");
  return {
    network,
    live: env.AGENT_LIVE === "1",
    budget: num("AGENT_BUDGET_USDC", 20),
    maxTrade: num("AGENT_MAX_TRADE_USDC", 5),
    minEdge: num("AGENT_MIN_EDGE", 0.05),
    slippageBps: BigInt(Math.round(num("AGENT_SLIPPAGE_BPS", 100))),
    intervalSeconds: num("AGENT_INTERVAL_SECONDS", 60),
    once: argv.includes("--once"),
  };
}

function client(s: Settings, env: NodeJS.ProcessEnv): HunchClient {
  if (!s.live) return createHunchClient({ network: s.network, rpcUrl: env.AGENT_RPC_URL });
  const key = env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("AGENT_LIVE=1 needs AGENT_PRIVATE_KEY (a wallet made for this agent).");
  const chain = s.network === "monad-mainnet" ? monadMainnet : monadTestnet;
  const walletClient = createWalletClient({
    account: privateKeyToAccount(key as `0x${string}`),
    chain,
    transport: http(env.AGENT_RPC_URL),
  });
  return createHunchClient({ network: s.network, rpcUrl: env.AGENT_RPC_URL, walletClient });
}

/** How many past funding events feed the model. */
const HISTORY_EVENTS = 48;

async function evaluate(hunch: HunchClient, m: MarketInfo) {
  if (m.decoded.kind !== "perpl-funding") return null;
  const p = m.decoded.params;
  const ctx = hunch.context;
  const exchange = await resolverExchange(ctx, m.resolver);
  const interval = await fundingInterval(ctx, exchange);
  const head = await ctx.publicClient.getBlockNumber();
  const [now] = await fundingAt(ctx, exchange, p.perpId, [head - 1n]);
  if (!now || now.eventBlock === 0n) return null;
  const grid = Array.from(
    { length: HISTORY_EVENTS + 1 },
    (_, k) => now.eventBlock - BigInt(HISTORY_EVENTS - k) * interval,
  );
  const reads = await fundingAt(ctx, exchange, p.perpId, [...grid, p.startBlock]);
  const history = reads.slice(0, -1).flatMap((r) => (r ? [Number(r.sum)] : []));
  const increments = history.slice(1).map((sum, i) => sum - (history[i] as number));
  const start = reads.at(-1);
  const accrued = head > p.startBlock && start ? Number(now.sum - start.sum) : 0;
  const eventsLeft = Math.max(0, Number((p.endBlock - now.eventBlock) / interval));
  return {
    ...estimateYes({ accrued, increments, eventsLeft, threshold: Number(p.threshold) }),
    accrued,
    eventsLeft,
  };
}

async function pass(hunch: HunchClient, s: Settings, spent: { usdc: number }): Promise<void> {
  const markets = (await hunch.markets.all()).filter(
    (m) => m.phase === Phase.Graduated && m.decoded.kind === "perpl-funding",
  );
  console.log(
    `${new Date().toISOString()} ${markets.length} trading funding market(s); budget left ${(s.budget - spent.usdc).toFixed(2)} USDC`,
  );
  for (const m of markets) {
    try {
      const e = await evaluate(hunch, m);
      if (!e) continue;
      const ask =
        m.prices?.askE6 === null || m.prices?.askE6 === undefined ? null : Number(m.prices.askE6) / 1e6;
      const decision = decide({
        pYes: e.pYes,
        ask,
        budgetLeft: s.budget - spent.usdc,
        maxTrade: s.maxTrade,
        minEdge: s.minEdge,
      });
      console.log(
        `  #${m.id} ${m.asset ?? ""}: paid so far ${e.accrued}, expected ${e.expected.toFixed(1)} vs threshold ${m.decoded.kind === "perpl-funding" ? m.decoded.params.threshold : "?"} ` +
          `(${e.eventsLeft} events left), model ${(e.pYes * 100).toFixed(1)}% YES, ask ${ask ?? "none"}: ` +
          (decision.action === "buy" ? `buy ${decision.usdc} USDC of YES` : `skip, ${decision.reason}`),
      );
      if (decision.action !== "buy") continue;
      const amount = parseUsdc(decision.usdc.toFixed(6));
      const quote = await hunch.quotes.buyYes(m, amount, { slippageBps: s.slippageBps });
      const avg = quote.avgPriceE6 === null ? null : Number(quote.avgPriceE6) / 1e6;
      if (quote.shortfall || !fillStillWorthIt(e.pYes, avg, s.minEdge)) {
        console.log(`    the fill would average ${avg ?? "nothing"}: not worth it, skipped`);
        continue;
      }
      if (!s.live) {
        console.log(
          `    dry run: would buy ${formatUsdc(quote.tokens)} YES for ${formatUsdc(quote.usdc)} USDC (average ${avg})`,
        );
        spent.usdc += decision.usdc;
        continue;
      }
      const tx = await hunch.actions.trade(m, "buyYes", amount, { slippageBps: s.slippageBps, quote });
      spent.usdc += decision.usdc;
      console.log(`    bought ${formatUsdc(tx.quote.tokens)} YES: ${tx.url}`);
    } catch (e) {
      console.log(`  #${m.id}: ${describeError(e)}`);
    }
  }
}

async function main(): Promise<void> {
  const s = settings(process.env, process.argv.slice(2));
  const hunch = client(s, process.env);
  console.log(
    `agent-trader on ${s.network}, ${s.live ? `LIVE from ${hunch.account}` : "dry run (set AGENT_LIVE=1 to trade)"}, budget ${s.budget} USDC, at most ${s.maxTrade} per trade, edge ${s.minEdge}`,
  );
  const spent = { usdc: 0 };
  for (;;) {
    await pass(hunch, s, spent);
    if (s.once) return;
    await new Promise((r) => setTimeout(r, s.intervalSeconds * 1000));
  }
}

main().catch((e: unknown) => {
  console.error(describeError(e));
  process.exit(1);
});
