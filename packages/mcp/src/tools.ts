import {
  addressUrl,
  formatBps,
  formatPriceE6,
  formatUsdc,
  type HunchClient,
  type MarketInfo,
  type MarketParamsInput,
  Phase,
  parseUsdc,
  type Quote,
  type SettlementPlan,
  SNAPSHOT_DEFAULT_WINDOW,
  SNAPSHOT_MAX_WINDOW,
  SNAPSHOT_MIN_WINDOW,
  TEMPLATES,
  type TradeKind,
  type Verification,
} from "@hunch-book/sdk";
import { isAddress } from "viem";
import { z } from "zod";
import type { McpConfig } from "./config.js";

// Every tool the server offers: its name, plain-word description, input schema and handler. Handlers
// take the SDK through a narrow port (`HunchPort`), so tests run them against a fake. Amounts go in
// and come out as decimal strings in USDC (or tokens): "12.5" is 12.5 USDC.

export type HunchPort = {
  network: HunchClient["network"];
  account: HunchClient["account"];
  deployment: HunchClient["deployment"];
  markets: Pick<HunchClient["markets"], "list" | "all" | "get" | "position" | "portfolio">;
  quotes: Pick<HunchClient["quotes"], "quote">;
  actions: Pick<
    HunchClient["actions"],
    "createMarket" | "stake" | "trade" | "settle" | "collect" | "collectAll" | "mintTestUsdc"
  >;
  settlement: Pick<HunchClient["settlement"], "plan" | "verify">;
};

export interface ToolContext {
  sdk: HunchPort;
  config: McpConfig;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** Sends a transaction: offered only when the server has a wallet. */
  write: boolean;
  handler: (input: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

/** Thrown for anything the caller can fix; the server returns its message as a tool error. */
export class ToolInputError extends Error {}

const address = z.string().refine((v) => isAddress(v), "a 0x address (40 hex characters)");
const amount = z.string().regex(/^\d+(\.\d{1,6})?$/, 'an amount like "10" or "12.5", at most 6 decimals');
const side = z.enum(["yes", "no"]);
const tradeKind = z.enum(["buyYes", "sellYes", "buyNo", "sellNo"]);
const PHASES = ["pool", "pool-locked", "trading", "closed", "settled", "voided"] as const;

const iso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

/** A market as an agent reads it: plain units, the rule sentence, the chance as a percent. */
export function summarizeMarket(m: MarketInfo, deployment: HunchPort["deployment"]) {
  const w = m.window;
  return {
    id: m.id,
    address: m.address,
    explorer: addressUrl(deployment, m.address),
    template: `${m.templateId} (${m.template})`,
    asset: m.asset,
    phase: m.phaseName,
    rule: m.rule,
    chanceOfYes: formatBps(m.chance.bps),
    chanceSource: m.chance.source,
    outcome: m.outcomeLabel,
    pool: {
      yesUsdc: formatUsdc(m.pool.yes),
      noUsdc: formatUsdc(m.pool.no),
      totalUsdc: formatUsdc(m.pool.total),
      stakers: m.pool.stakers,
    },
    book: m.book
      ? {
          address: m.book,
          bid: formatPriceE6(m.prices?.bidE6 ?? null),
          ask: formatPriceE6(m.prices?.askE6 ?? null),
        }
      : null,
    window: w.blockClock
      ? {
          clock: "block",
          lockBlock: w.lock.toString(),
          closeBlock: w.close.toString(),
          settleBy: iso(w.settleDeadline),
        }
      : { clock: "time", lock: iso(w.lock), close: iso(w.close), settleBy: iso(w.settleDeadline) },
    tokens: m.tokens,
    graduationRuleMet: m.graduationRuleMet,
    minStakeUsdc: formatUsdc(m.caps.minStake),
  };
}

const SHORTFALL: Record<string, string> = {
  empty: "The side of the book this trade needs has no orders.",
  liquidity: "The book cannot fill the whole amount.",
  dust: "The amount is too small to fill anything.",
  price: "Selling NO here would cost more than the merge returns.",
};

export function summarizeQuote(q: Quote) {
  const buy = q.kind === "buyYes" || q.kind === "buyNo";
  const token = q.kind === "buyYes" || q.kind === "sellYes" ? "YES" : "NO";
  return {
    kind: q.kind,
    canFill: q.shortfall === null,
    problem: q.shortfall ? SHORTFALL[q.shortfall] : null,
    youPayUsdc: buy ? formatUsdc(q.usdc) : null,
    youReceiveUsdc: buy ? null : formatUsdc(q.usdc),
    tokens: `${formatUsdc(q.tokens)} ${token}`,
    averagePrice: formatPriceE6(q.avgPriceE6),
    touchPrice: formatPriceE6(q.touchPriceE6),
    yesMidPrice: formatPriceE6(q.midE6),
    impactBps: q.impactBps === null ? null : Number(q.impactBps),
    slippageBps: Number(q.slippageBps),
    limit:
      q.kind === "buyNo"
        ? `pay at most ${formatUsdc(q.limit)} USDC`
        : q.kind === "buyYes"
          ? `receive at least ${formatUsdc(q.limit)} YES`
          : `receive at least ${formatUsdc(q.limit)} USDC`,
    bookBlock: q.block.toString(),
  };
}

export function summarizePlan(plan: SettlementPlan) {
  if (plan.status === "ready") {
    return {
      status: plan.status,
      method: plan.method,
      outcome: plan.outcomeLabel,
      evidence: plan.evidence,
      evidenceHash: plan.evidenceHash,
      feeMonWei: plan.value.toString(),
      detail: plan.detail,
    };
  }
  return plan;
}

export function summarizeVerification(v: Verification) {
  return {
    market: v.market,
    id: v.marketId,
    status: v.status,
    verified: v.verified,
    stored: v.stored,
    recomputed: {
      outcome: v.recomputed.outcome,
      evidenceHash: v.recomputed.evidenceHash,
      reads: v.recomputed.reads,
    },
    rerun: v.rerun,
    rerunError: v.rerunError,
    matches: v.matches,
    notes: v.notes,
    settlementTx: v.settlement
      ? { hash: v.settlement.hash, block: v.settlement.block.toString(), by: v.settlement.by }
      : null,
    plan: v.plan ? summarizePlan(v.plan) : null,
    checkedAtBlock: v.checkedAt.block.toString(),
  };
}

function capUsdc(value: bigint, config: McpConfig, what: string): void {
  if (value > config.maxUsdcPerCall) {
    throw new ToolInputError(
      `${what} of ${formatUsdc(value)} USDC is above this server's limit of ${formatUsdc(config.maxUsdcPerCall)} USDC per call (HUNCH_MCP_MAX_USDC_PER_CALL).`,
    );
  }
}

async function requireMarketInfo(sdk: HunchPort, market: string): Promise<MarketInfo> {
  const info = await sdk.markets.get(market as `0x${string}`);
  if (!info) throw new ToolInputError(`${market} is not a Hunch Book market on ${sdk.network}.`);
  return info;
}

// ---------------------------------------------------------------- template params

const big = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));
const unsignedBig = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const ZERO32 = `0x${"00".repeat(32)}` as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const PARAM_SCHEMAS = {
  1: z.object({
    perpId: unsignedBig,
    startBlock: unsignedBig,
    endBlock: unsignedBig,
    threshold: big,
    expectedScalingExp: z.number().int().min(0).max(255),
  }),
  2: z.object({
    source: z.enum(["chainlink", "pyth"]),
    feed: address.optional(),
    pythId: hex32.optional(),
    strikeE8: big,
    lockTime: unsignedBig,
    closeTime: unsignedBig,
  }),
  3: z.object({
    feed: address,
    strikeE8: big,
    direction: z.enum(["atOrAbove", "atOrBelow"]),
    lockTime: unsignedBig,
    startTime: unsignedBig,
    endTime: unsignedBig,
  }),
  4: z.object({
    perpId: unsignedBig,
    startBlock: unsignedBig,
    endBlock: unsignedBig,
    threshold: big,
    expectedScalingExp: z.number().int().min(0).max(255),
  }),
  5: z.object({
    source: z.enum(["chainlink", "pyth"]),
    feed: address.optional(),
    pythId: hex32.optional(),
    lowerE8: big,
    upperE8: big,
    lockTime: unsignedBig,
    closeTime: unsignedBig,
  }),
  6: z.object({ legs: z.array(address).min(2).max(5), lockTime: unsignedBig, closeTime: unsignedBig }),
  7: z.object({
    sourceId: z.number().int().min(0).max(65_535),
    threshold: big,
    comparator: z.enum(["above", "atOrAbove", "below", "atOrBelow"]),
    lockTime: unsignedBig,
    closeTime: unsignedBig,
    snapshotWindow: z
      .number()
      .int()
      .min(SNAPSHOT_MIN_WINDOW)
      .max(SNAPSHOT_MAX_WINDOW)
      .default(SNAPSHOT_DEFAULT_WINDOW),
  }),
} as const;

const COMPARATOR = { above: 0, atOrAbove: 1, below: 2, atOrBelow: 3 } as const;

/** Turns the JSON params an agent sends into the SDK's typed params for one template. */
export function parseTemplateParams(templateId: number, raw: unknown): MarketParamsInput {
  const schema = PARAM_SCHEMAS[templateId as keyof typeof PARAM_SCHEMAS];
  if (!schema) throw new ToolInputError(`Template ${templateId} is not one of 1 to 7.`);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolInputError(
      `Params for template ${templateId} are not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`,
    );
  }
  const p = parsed.data as Record<string, unknown>;
  switch (templateId) {
    case 2:
    case 5: {
      const chainlink = p.source === "chainlink";
      if (chainlink ? !p.feed : !p.pythId) {
        throw new ToolInputError(
          chainlink ? "A Chainlink price market needs `feed`." : "A Pyth price market needs `pythId`.",
        );
      }
      const common = {
        source: chainlink ? 0 : 1,
        feed: (chainlink ? p.feed : ZERO_ADDRESS) as `0x${string}`,
        pythId: (chainlink ? ZERO32 : p.pythId) as `0x${string}`,
        lockTime: p.lockTime as bigint,
        closeTime: p.closeTime as bigint,
      } as const;
      return templateId === 2
        ? { templateId: 2, params: { ...common, strikeE8: p.strikeE8 as bigint } }
        : {
            templateId: 5,
            params: { ...common, lowerE8: p.lowerE8 as bigint, upperE8: p.upperE8 as bigint },
          };
    }
    case 3:
      return {
        templateId: 3,
        params: {
          feed: p.feed as `0x${string}`,
          strikeE8: p.strikeE8 as bigint,
          direction: p.direction === "atOrAbove" ? 0 : 1,
          lockTime: p.lockTime as bigint,
          startTime: p.startTime as bigint,
          endTime: p.endTime as bigint,
        },
      };
    case 7:
      return {
        templateId: 7,
        params: {
          sourceId: p.sourceId as number,
          threshold: p.threshold as bigint,
          comparator: COMPARATOR[p.comparator as keyof typeof COMPARATOR],
          lockTime: p.lockTime as bigint,
          closeTime: p.closeTime as bigint,
          snapshotWindow: p.snapshotWindow as number,
        },
      };
    default:
      return { templateId: templateId as 1 | 4 | 6, params: p as never } as MarketParamsInput;
  }
}

// ---------------------------------------------------------------- tools

const tool = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> => def;

export const TOOLS = [
  tool({
    name: "status",
    title: "Server status",
    description:
      "The network this server uses, whether it can send transactions (and from which wallet), the per-call limits, and the Hunch Book contract addresses.",
    inputSchema: {},
    write: false,
    handler: async (_input, { sdk, config }) => ({
      network: sdk.network,
      chainId: sdk.deployment.chainId,
      mode: sdk.account ? "read and write" : "read-only (set HUNCH_MCP_PRIVATE_KEY to send transactions)",
      wallet: sdk.account ?? null,
      limits: {
        maxUsdcPerCall: formatUsdc(config.maxUsdcPerCall),
        maxTokensPerCall: formatUsdc(config.maxTokensPerCall),
        maxSlippageBps: Number(config.maxSlippageBps),
        defaultSlippageBps: Number(config.defaultSlippageBps),
      },
      explorer: sdk.deployment.explorer,
      contracts: {
        factory: sdk.deployment.hunchBook.factory ?? null,
        vault: sdk.deployment.hunchBook.vault ?? null,
        router: sdk.deployment.hunchBook.router ?? null,
        usdc: sdk.deployment.hunchBook.usdc ?? sdk.deployment.external.usdc ?? null,
      },
      templates: Object.values(TEMPLATES).map((t) => ({
        id: t.id,
        name: t.label,
        question: t.question,
        clock: t.clock,
        earlyYes: t.earlyYes,
      })),
    }),
  }),

  tool({
    name: "list_markets",
    title: "List markets",
    description:
      "Lists Hunch Book markets, newest first, with each market's rule in one sentence, phase, chance of YES, pool totals and best book prices. Filter by phase (pool, pool-locked, trading, closed, settled, voided), template id (1 to 7) or asset (BTC, ETH, MON, SOL).",
    inputSchema: {
      phase: z.enum(PHASES).optional().describe("Only markets in this phase."),
      template: z.number().int().min(1).max(7).optional().describe("Only markets on this template id."),
      asset: z.string().max(16).optional().describe('Only markets on this asset, for example "BTC".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("How many markets to return (default 20, at most 50)."),
    },
    write: false,
    handler: async (input, { sdk }) => {
      const all = await sdk.markets.all();
      const want = input.asset?.trim().toUpperCase();
      const filtered = all.filter(
        (m) =>
          (!input.phase || m.phaseName === input.phase) &&
          (!input.template || m.templateId === input.template) &&
          (!want || (m.asset ?? "").toUpperCase().split("/")[0] === want.split("/")[0]),
      );
      const limit = input.limit ?? 20;
      return {
        network: sdk.network,
        total: all.length,
        matching: filtered.length,
        markets: filtered.slice(0, limit).map((m) => summarizeMarket(m, sdk.deployment)),
      };
    },
  }),

  tool({
    name: "get_market",
    title: "Get one market",
    description:
      "One market in full: the exact rule, phase, window, pool, book prices, chance, outcome, and what settling it now would take. With a wallet, also the wallet's position in it.",
    inputSchema: { market: address.describe("The market's address.") },
    write: false,
    handler: async (input, { sdk }) => {
      const m = await requireMarketInfo(sdk, input.market);
      const [plan, position] = await Promise.all([
        sdk.settlement.plan(m),
        sdk.account ? sdk.markets.position(m, sdk.account) : Promise.resolve(null),
      ]);
      return {
        ...summarizeMarket(m, sdk.deployment),
        decodedParams: m.decoded,
        graduationRule: {
          minPoolUsdc: formatUsdc(m.graduationRule.minPool),
          minStakers: m.graduationRule.minStakers,
          chanceRange: `${formatBps(m.graduationRule.minChanceBps)} to ${formatBps(m.graduationRule.maxChanceBps)}`,
        },
        evidenceHash: m.evidenceHash,
        settlement: summarizePlan(plan),
        yourPosition: position
          ? {
              stakeUsdc: { yes: formatUsdc(position.stake.yes), no: formatUsdc(position.stake.no) },
              tokens: { yes: formatUsdc(position.balances.yes), no: formatUsdc(position.balances.no) },
              claimableTokens: {
                yes: formatUsdc(position.claimableTokens.yes),
                no: formatUsdc(position.claimableTokens.no),
              },
              claimablePoolUsdc: formatUsdc(position.claimablePool.paid),
            }
          : null,
      };
    },
  }),

  tool({
    name: "quote",
    title: "Quote a trade",
    description:
      "Quotes a trade on a trading market's Kuru book, exactly as the router would fill it now. kind: buyYes (amount = USDC to spend), sellYes (amount = YES to sell), buyNo (amount = NO to receive), sellNo (amount = NO to sell). Returns what you pay and get, the average price, the impact against the mid, and the slippage limit a trade would use.",
    inputSchema: {
      market: address.describe("The market's address."),
      kind: tradeKind,
      amount: amount.describe("USDC for buyYes; tokens for the other kinds."),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(5_000)
        .optional()
        .describe("Slippage allowance in basis points (default from the server)."),
    },
    write: false,
    handler: async (input, { sdk, config }) => {
      const slippage = BigInt(input.slippageBps ?? Number(config.defaultSlippageBps));
      const q = await sdk.quotes.quote(
        input.market as `0x${string}`,
        input.kind as TradeKind,
        parseUsdc(input.amount),
        {
          slippageBps: slippage,
        },
      );
      return summarizeQuote(q);
    },
  }),

  tool({
    name: "get_portfolio",
    title: "Get a portfolio",
    description:
      "A wallet's positions across every market: stakes, YES and NO tokens, tokens still to claim, and pool payouts to claim. Defaults to this server's wallet.",
    inputSchema: {
      wallet: address.optional().describe("The wallet to read (default: this server's wallet)."),
    },
    write: false,
    handler: async (input, { sdk }) => {
      const wallet = (input.wallet ?? sdk.account) as `0x${string}` | undefined;
      if (!wallet)
        throw new ToolInputError("Name a wallet: this server has none of its own (read-only mode).");
      const entries = await sdk.markets.portfolio(wallet);
      return {
        wallet,
        positions: entries.map((e) => ({
          market: summarizeMarket(e.info, sdk.deployment),
          stakeUsdc: { yes: formatUsdc(e.stake.yes), no: formatUsdc(e.stake.no) },
          tokens: { yes: formatUsdc(e.balances.yes), no: formatUsdc(e.balances.no) },
          claimableTokens: { yes: formatUsdc(e.claimableTokens.yes), no: formatUsdc(e.claimableTokens.no) },
          claimablePoolUsdc: formatUsdc(e.claimablePool.paid),
        })),
      };
    },
  }),

  tool({
    name: "verify_settlement",
    title: "Verify a settlement",
    description:
      "Checks a settled market from the chain alone: reads the source again, rebuilds the evidence hash the resolver stored, and re-runs the resolver. verified = true means the stored outcome is reproduced. For a market that has not settled, shows what settling now would do.",
    inputSchema: { market: address.describe("The market's address.") },
    write: false,
    handler: async (input, { sdk }) => {
      await requireMarketInfo(sdk, input.market);
      return summarizeVerification(await sdk.settlement.verify(input.market as `0x${string}`));
    },
  }),

  tool({
    name: "create_market",
    title: "Create a market",
    description: [
      "Creates a market from a template and makes the creator's first stake (at least 5 USDC). Template params by id:",
      "1 Perpl net funding: perpId, startBlock, endBlock, threshold (raw funding units), expectedScalingExp.",
      '2 price at a time: source ("chainlink" with feed, or "pyth" with pythId), strikeE8 (USD x 1e8), lockTime, closeTime (unix seconds).',
      '3 price touch: feed, strikeE8, direction ("atOrAbove" or "atOrBelow"), lockTime, startTime, endTime.',
      "4 Perpl funding spike: as template 1, threshold for one funding event.",
      "5 price range: as template 2 with lowerE8 and upperE8 instead of strikeE8.",
      "6 parlay: legs (2 to 5 market addresses), lockTime, closeTime.",
      '7 snapshot: sourceId (from the resolver\'s source list), threshold (raw units), comparator ("above", "atOrAbove", "below" or "atOrBelow"), lockTime, closeTime, snapshotWindow (60 to 1800 seconds, default 600).',
      "Numbers may be strings. docs://hunch-book/templates has every rule.",
    ].join(" "),
    inputSchema: {
      templateId: z.number().int().min(1).max(7),
      params: z
        .record(z.string(), z.unknown())
        .describe("The template's params, as listed in the description."),
      side: side.describe("The side of the creator's first stake."),
      firstStake: amount.describe("USDC for the first stake."),
    },
    write: true,
    handler: async (input, { sdk, config }) => {
      const firstStake = parseUsdc(input.firstStake);
      capUsdc(firstStake, config, "A first stake");
      const typed = parseTemplateParams(input.templateId, input.params);
      const tx = await sdk.actions.createMarket({
        templateId: typed.templateId,
        params: typed.params,
        side: input.side,
        firstStake,
      });
      return {
        market: tx.market,
        tx: tx.hash,
        explorer: tx.url,
        marketExplorer: addressUrl(sdk.deployment, tx.market),
      };
    },
  }),

  tool({
    name: "stake",
    title: "Stake in a pool",
    description:
      "Stakes USDC on YES or NO in a market that is still a pool. Approves the vault first if needed.",
    inputSchema: { market: address, side, amount: amount.describe("USDC to stake.") },
    write: true,
    handler: async (input, { sdk, config }) => {
      const value = parseUsdc(input.amount);
      capUsdc(value, config, "A stake");
      const tx = await sdk.actions.stake(input.market as `0x${string}`, input.side, value);
      return { staked: `${input.amount} USDC on ${input.side.toUpperCase()}`, tx: tx.hash, explorer: tx.url };
    },
  }),

  tool({
    name: "trade",
    title: "Trade on the book",
    description:
      "Trades through Hunch Book's router on a trading market's Kuru book, with a slippage limit and a deadline. kind and amount as in quote. Quote first to see the price.",
    inputSchema: {
      market: address,
      kind: tradeKind,
      amount: amount.describe("USDC for buyYes; tokens for the other kinds."),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(5_000)
        .optional()
        .describe("Slippage allowance in basis points."),
    },
    write: true,
    handler: async (input, { sdk, config }) => {
      const value = parseUsdc(input.amount);
      const slippage = BigInt(input.slippageBps ?? Number(config.defaultSlippageBps));
      if (slippage > config.maxSlippageBps) {
        throw new ToolInputError(
          `Slippage of ${slippage} bps is above this server's limit of ${config.maxSlippageBps} bps.`,
        );
      }
      const kind = input.kind as TradeKind;
      const q = await sdk.quotes.quote(input.market as `0x${string}`, kind, value, { slippageBps: slippage });
      if (kind === "buyYes") capUsdc(value, config, "A buy");
      else if (kind === "buyNo") capUsdc(q.limit, config, "A buy, at its most,");
      else if (value > config.maxTokensPerCall) {
        throw new ToolInputError(
          `Selling ${input.amount} tokens is above this server's limit of ${formatUsdc(config.maxTokensPerCall)} per call.`,
        );
      }
      const tx = await sdk.actions.trade(input.market as `0x${string}`, kind, value, {
        slippageBps: slippage,
        quote: q,
      });
      return { quote: summarizeQuote(tx.quote), tx: tx.hash, explorer: tx.url };
    },
  }),

  tool({
    name: "settle",
    title: "Settle a market",
    description:
      "Settles a market whose answer is in, with the evidence found automatically for every template (a touch proved before close goes through proveYes). If it cannot settle yet, says why and sends nothing.",
    inputSchema: { market: address },
    write: true,
    handler: async (input, { sdk }) => {
      const info = await requireMarketInfo(sdk, input.market);
      const plan = await sdk.settlement.plan(info);
      if (plan.status !== "ready") return { settled: false, ...summarizePlan(plan) };
      const tx = await sdk.actions.settle(info);
      return { settled: true, method: tx.method, outcome: plan.outcomeLabel, tx: tx.hash, explorer: tx.url };
    },
  }),

  tool({
    name: "redeem",
    title: "Collect a finished market",
    description:
      "Gets this wallet's USDC out of a settled or voided market: claims unclaimed tokens, claims a pool payout or refund, and redeems the winning tokens (both sides at 0.50 after a void).",
    inputSchema: { market: address },
    write: true,
    handler: async (input, { sdk }) => {
      const info = await requireMarketInfo(sdk, input.market);
      const txs = await sdk.actions.collect(info);
      return {
        transactions: txs.map((t) => ({ tx: t.hash, explorer: t.url })),
        note: txs.length === 0 ? "Nothing to collect for this wallet." : null,
      };
    },
  }),

  tool({
    name: "redeem_all",
    title: "Collect every finished market",
    description:
      "Gets this wallet's USDC out of every settled or voided market it holds a position in: claims tokens, claims pool payouts and redeems, in one batch when the wallet can send one atomically (EIP-5792) and one transaction at a time otherwise. Markets still open are left alone.",
    inputSchema: {},
    write: true,
    handler: async (_input, { sdk }) => {
      const wallet = sdk.account;
      if (!wallet) throw new ToolInputError("This server has no wallet (read-only mode).");
      const entries = await sdk.markets.portfolio(wallet);
      const finished = entries
        .map((e) => e.info)
        .filter((m) => m.phase === Phase.Settled || m.phase === Phase.Voided);
      if (finished.length === 0)
        return { mode: null, calls: [], transactions: [], note: "Nothing to collect." };
      const result = await sdk.actions.collectAll(finished);
      return {
        mode: result.mode,
        calls: result.calls.map((c) => c.label),
        transactions: result.transactions.map((t) => ({ tx: t.hash, explorer: t.url })),
        note: result.calls.length === 0 ? "Nothing to collect for this wallet." : null,
      };
    },
  }),

  tool({
    name: "get_test_usdc",
    title: "Get test USDC",
    description:
      "Monad testnet only: mints Hunch Book's test USDC to this server's wallet (at most 10,000 per call).",
    inputSchema: { amount: amount.describe("USDC to mint.") },
    write: true,
    handler: async (input, { sdk }) => {
      if (sdk.network !== "monad-testnet")
        throw new ToolInputError("Test USDC exists only on Monad testnet.");
      const value = parseUsdc(input.amount);
      const tx = await sdk.actions.mintTestUsdc(value);
      return { minted: `${input.amount} test USDC`, tx: tx.hash, explorer: tx.url };
    },
  }),
] as const;

export type AnyTool = (typeof TOOLS)[number];
