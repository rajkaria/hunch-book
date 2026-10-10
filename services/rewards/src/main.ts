import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createContext,
  formatUsdc,
  type HunchContext,
  listAllMarkets,
  marketVenue,
  nextRewardEpoch,
  parseUsdc,
  referralOf,
  toJsonSafe,
} from "@hunch-book/sdk";
import { collateralOf, type Network } from "@hunch-book/shared";
import { type Address, getAddress, isAddress } from "viem";
import { buildEpoch } from "./epoch.js";
import { type Binding, creditReferrers, DEFAULT_REFERRAL_SHARE_BPS, type FeeEvent } from "./referrals.js";
import { sampleFromLine, sampleMarket, sampleToLine } from "./sample.js";
import { DEFAULT_BAND_E6, type MakerReward, makerRewards, type Sample, scoreMarket } from "./score.js";
import { feeEventsFromIndexer, feeEventsFromLogs } from "./sources.js";

// The rewards CLI. Dry run only: it reads the chain (and the indexer, when configured) and writes
// files; it never sends a transaction. docs/REWARDS.md has the formulas and the steps.
//
//   rewards sample    --from <block> --to <block> [--every 200] [--market <address>] [--check] [--out samples.jsonl]
//   rewards makers    --samples samples.jsonl --pool <USDC per market> [--band 0.03] [--out makers.json]
//   rewards referrals --from <block> --to <block> [--share-bps 2000] [--out referrals.json]
//   rewards epoch     [--makers makers.json] [--referrals referrals.json] [--epoch <id>] [--claim-days 14] [--out epoch.json]

const HELP = `Hunch Book rewards (dry run: reads the chain, writes files, sends nothing)

  sample     Sample every graduated market's order book (Kuru v1 or Hunch Book's own) every N blocks.
             --from <block> --to <block> [--every 200] [--market <address>] [--replay-from <block>] [--check] [--out samples.jsonl]
  makers     Score makers from a samples file and split each market's pool.
             --samples samples.jsonl --pool <USDC per market> [--band 0.03] [--pay-our-maker] [--out makers.json]
  referrals  Credit referrers for fees their referred users paid while bound.
             --from <block> --to <block> [--share-bps 2000] [--out referrals.json]
  epoch      Merge maker rewards and referral credits into one MerkleDistributor epoch.
             [--makers makers.json] [--referrals referrals.json] [--epoch <id>] [--claim-days 14] [--out epoch.json]

Environment: REWARDS_NETWORK (monad-testnet), REWARDS_RPC_URL, INDEXER_URL.`;

function context(env: NodeJS.ProcessEnv): HunchContext {
  const network = (env.REWARDS_NETWORK ?? "monad-testnet") as Network;
  if (network !== "monad-testnet" && network !== "monad-mainnet")
    throw new Error("REWARDS_NETWORK must be monad-testnet or monad-mainnet");
  return createContext({ network, rpcUrl: env.REWARDS_RPC_URL || undefined });
}

const block = (value: string | undefined, name: string): bigint => {
  if (!value || !/^\d+$/.test(value)) throw new Error(`--${name} must be a block number`);
  return BigInt(value);
};

const write = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(toJsonSafe(value), null, 2)}\n`);
  console.log(`wrote ${path}`);
};

async function sample(
  ctx: HunchContext,
  args: Record<string, string | boolean | string[] | undefined>,
): Promise<void> {
  const from = block(args.from as string, "from");
  const to = block(args.to as string, "to");
  const every = BigInt((args.every as string | undefined) ?? "200");
  if (every <= 0n || to < from) throw new Error("--to must be at or after --from, and --every above zero");
  const wanted = ((args.market as string[] | undefined) ?? []).map((a) => {
    if (!isAddress(a)) throw new Error(`${a} is not an address`);
    return getAddress(a);
  });
  // Kuru v2 books report orders as packed events this sampler does not decode yet: only v1 books are
  // sampled (Kuru v1's, and Hunch Book's own order books, which emit the same events), and v2 markets
  // are named in the log so nobody mistakes the gap for no liquidity.
  const all = await listAllMarkets(ctx);
  const skippedV2 = all.filter((m) => m.kuruVersion === 2 && m.graduated && m.book).map((m) => m.address);
  if (skippedV2.length > 0) {
    console.error(
      `skipping ${skippedV2.length} market(s) on Kuru v2 books (not sampled yet): ${skippedV2.join(", ")}`,
    );
  }
  const markets = all.filter(
    (m) =>
      m.kuruVersion !== 2 && m.graduated && m.book && (wanted.length === 0 || wanted.includes(m.address)),
  );
  const out = (args.out as string | undefined) ?? "samples.jsonl";
  const lines: string[] = [];
  for (const m of markets) {
    const result = await sampleMarket(ctx, m, {
      from,
      to,
      every,
      ...(args["replay-from"] ? { replayFrom: block(args["replay-from"] as string, "replay-from") } : {}),
      check: Boolean(args.check),
    });
    const mismatched = result.samples.filter((s) => s.l2Match === false).length;
    console.log(
      `#${m.id} ${m.address} (${marketVenue(m).label}): ${result.samples.length} samples from ${result.events} book events (replayed from block ${result.replayFrom})${args.check ? `, ${mismatched} differ from getL2Book` : ""}`,
    );
    lines.push(...result.samples.map(sampleToLine));
  }
  writeFileSync(out, lines.length ? `${lines.join("\n")}\n` : "");
  console.log(`wrote ${lines.length} samples to ${out}`);
}

function makers(ctx: HunchContext, args: Record<string, string | boolean | string[] | undefined>): void {
  const file = (args.samples as string | undefined) ?? "samples.jsonl";
  const samples = readFileSync(file, "utf8").split("\n").filter(Boolean).map(sampleFromLine);
  const skippedDrift = samples.filter((s) => s.l2Match === false).length;
  const usable: Sample[] = samples.filter((s) => s.l2Match !== false);
  const pool = parseUsdc(String(args.pool ?? "0"));
  const band = args.band ? parseUsdc(String(args.band)) : DEFAULT_BAND_E6;
  const byMarket = new Map<Address, Sample[]>();
  for (const s of usable) byMarket.set(s.market, [...(byMarket.get(s.market) ?? []), s]);
  const ourMakers = [ctx.deployment.wallets.maker];
  const markets = [...byMarket.entries()].map(([market, list]) => {
    const score = scoreMarket(market, list, band);
    return {
      score,
      rewards: makerRewards(score, pool, { ourMakers, payOurMaker: Boolean(args["pay-our-maker"]) }),
    };
  });
  for (const { score, rewards } of markets) {
    console.log(`${score.market}: ${score.samples} two-sided samples, ${score.skipped} one-sided`);
    for (const r of rewards) {
      console.log(
        `  ${r.maker}${r.ours ? " (Hunch Book's maker bot, ours: not paid)" : ""}: ${(r.shareBps / 100).toFixed(2)}% of the score, at the touch ${(r.timeAtTouchBps / 100).toFixed(2)}% of samples, ${formatUsdc(r.reward)} USDC`,
      );
    }
  }
  if (skippedDrift)
    console.log(`left out ${skippedDrift} samples whose rebuilt book differed from getL2Book`);
  write((args.out as string | undefined) ?? "makers.json", {
    program: "maker rewards (V-5), docs/PERIPHERY.md",
    bandE6: band,
    poolPerMarket: pool,
    samplesFile: file,
    ourMakers,
    markets: markets.map(({ score, rewards }) => ({
      market: score.market,
      samples: score.samples,
      skipped: score.skipped,
      rewards,
    })),
  });
}

async function referrals(
  ctx: HunchContext,
  args: Record<string, string | boolean | string[] | undefined>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const from = block(args.from as string, "from");
  const to = block(args.to as string, "to");
  const shareBps = args["share-bps"] ? BigInt(args["share-bps"] as string) : DEFAULT_REFERRAL_SHARE_BPS;
  if (!ctx.deployment.hunchBook.periphery?.referralRegistry)
    throw new Error("The referral registry is not deployed on this network.");
  let events: FeeEvent[];
  let source: string;
  if (env.INDEXER_URL) {
    try {
      events = await feeEventsFromIndexer(fetch, env.INDEXER_URL, from, to);
      source = "indexer";
    } catch (e) {
      console.log(`the indexer failed (${e instanceof Error ? e.message : String(e)}); reading logs`);
      events = await feeEventsFromLogs(
        ctx,
        (await listAllMarkets(ctx)).map((m) => m.address),
        from,
        to,
      );
      source = "logs";
    }
  } else {
    events = await feeEventsFromLogs(
      ctx,
      (await listAllMarkets(ctx)).map((m) => m.address),
      from,
      to,
    );
    source = "logs";
  }
  const cache = new Map<string, Binding | null>();
  const bindingAt = async (user: Address, e: FeeEvent): Promise<Binding | null> => {
    const key = `${user}-${e.block}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    let b: Binding | null;
    try {
      // The binding as the chain had it at the fee's block: exact, where the RPC keeps past state.
      b = await referralOf(ctx, user, { blockNumber: e.block });
    } catch {
      // Otherwise the latest binding, which covers the fee only if its window does.
      b = await referralOf(ctx, user).catch(() => null);
    }
    cache.set(key, b);
    return b;
  };
  const result = await creditReferrers(events, bindingAt, shareBps);
  console.log(
    `${events.length} fee events from the ${source}, ${result.rows.length} credited, ${result.unbound} with no active binding`,
  );
  for (const [referrer, amount] of result.credits) console.log(`  ${referrer}: ${formatUsdc(amount)} USDC`);
  write((args.out as string | undefined) ?? "referrals.json", {
    program: "referral shares (C-8), docs/PERIPHERY.md",
    fromBlock: from,
    toBlock: to,
    shareBps,
    source,
    credits: [...result.credits.entries()].map(([referrer, amount]) => ({ referrer, amount })),
    rows: result.rows.map((r) => ({ ...r.event, referrer: r.referrer, credit: r.credit })),
  });
}

async function epoch(
  ctx: HunchContext,
  args: Record<string, string | boolean | string[] | undefined>,
): Promise<void> {
  const token = collateralOf(ctx.deployment);
  if (!token) throw new Error("No collateral token in the deployments file.");
  const distributor = ctx.deployment.hunchBook.periphery?.merkleDistributor ?? null;
  const id = args.epoch ? BigInt(args.epoch as string) : distributor ? await nextRewardEpoch(ctx) : 0n;
  const days = BigInt((args["claim-days"] as string | undefined) ?? "14");
  if (days < 8n)
    throw new Error(
      "--claim-days must be at least 8: the distributor wants 7 days from creation, plus time to fund",
    );
  const now = (await ctx.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  const makerRows: MakerReward[] = [];
  if (args.makers) {
    const j = JSON.parse(readFileSync(args.makers as string, "utf8")) as {
      markets: {
        rewards: {
          market: Address;
          maker: Address;
          earned: string;
          reward: string;
          shareBps: number;
          timeAtTouchBps: number;
          ours: boolean;
        }[];
      }[];
    };
    for (const m of j.markets) {
      for (const r of m.rewards) makerRows.push({ ...r, earned: BigInt(r.earned), reward: BigInt(r.reward) });
    }
  }
  const credits = new Map<Address, bigint>();
  if (args.referrals) {
    const j = JSON.parse(readFileSync(args.referrals as string, "utf8")) as {
      credits: { referrer: Address; amount: string }[];
    };
    for (const c of j.credits)
      credits.set(getAddress(c.referrer), (credits.get(getAddress(c.referrer)) ?? 0n) + BigInt(c.amount));
  }
  const file = buildEpoch({
    network: ctx.deployment.network,
    epoch: id,
    token,
    distributor,
    claimDeadline: now + days * 86_400n,
    makers: makerRows,
    referrals: credits,
    programs: { makersFile: args.makers ?? null, referralsFile: args.referrals ?? null },
  });
  console.log(
    `epoch ${file.epoch}: ${file.claims.length} accounts, ${file.totalUsdc} USDC, root ${file.root ?? "(no claims)"}`,
  );
  for (const x of file.excluded)
    console.log(
      `  excluded ${x.account} (ours): would have earned ${formatUsdc(BigInt(x.wouldHaveEarned))} USDC`,
    );
  if (file.fund) {
    console.log("dry run: nothing was sent. To fund it, the distributor's funder sends, in order:");
    console.log(`  1. ${file.fund.approve.to} approve: ${file.fund.approve.data}`);
    console.log(`  2. ${file.fund.createEpoch.to} createEpoch: ${file.fund.createEpoch.data}`);
  }
  write((args.out as string | undefined) ?? "epoch.json", file);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      every: { type: "string" },
      market: { type: "string", multiple: true },
      "replay-from": { type: "string" },
      check: { type: "boolean" },
      out: { type: "string" },
      samples: { type: "string" },
      pool: { type: "string" },
      band: { type: "string" },
      "pay-our-maker": { type: "boolean" },
      "share-bps": { type: "string" },
      makers: { type: "string" },
      referrals: { type: "string" },
      epoch: { type: "string" },
      "claim-days": { type: "string" },
    },
  });
  const ctx = context(process.env);
  switch (command) {
    case "sample":
      return sample(ctx, values);
    case "makers":
      return makers(ctx, values);
    case "referrals":
      return referrals(ctx, values, process.env);
    case "epoch":
      return epoch(ctx, values);
    default:
      console.log(HELP);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
