import type { MarketInfo } from "@hunch-book/sdk";
import {
  graduatorV2Abi,
  kuruV2AccountCoreAbi,
  kuruV2SpotRouterAbi,
  kuruV2WithdrawalLimiterAbi,
  outcomeTokenPriceAdapterFactoryAbi,
  Phase,
  stackNamed,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { cached } from "./cache";
import type { ApiDeps } from "./deps";
import { CACHE, json, problem } from "./http";
import { allMarkets } from "./markets";

// GET /api/v1/kuru/requests: what Kuru needs to set up for each market on a Kuru v2 stack that has no book
// yet (docs/PROTOCOL.md §8.1, Kuru v2; docs/API.md). Kuru creates every v2 book after setting up its YES
// token (a price source in the WithdrawalLimiter over the market's feed, enabling it in AccountCore,
// whitelisting it), and that takes days, so markets are listed from creation, not when they fill. Every
// field is read from the chain on the request: GraduatorV2's request and predicted address, the feeds,
// and Kuru's own records of what is done.

/** GraduatorV2.Problem, in words (contracts/src/interfaces/IGraduatorV2.sol). */
const PROBLEMS = [
  "none",
  "no contract there",
  "Kuru's SpotRouter did not deploy it",
  "Kuru's AccountCore has not registered it",
  "it points at another AccountCore",
  "its base or quote is not this market's YES token and USDC",
  "its precisions are not 1e6 / 1e6",
  "its tick size is outside the limits",
  "its fees are outside the limits",
  "its minimum order is above the limit",
  "Kuru has not enabled the YES token or USDC",
  "the WithdrawalLimiter has no price source for the YES token or USDC",
] as const;

export type RequestStatus = "needs-token-setup" | "needs-book" | "book-not-registrable" | "ready-to-register";

export interface TokenSetup {
  token: Address;
  /** The feed Kuru's price source should wrap (the market's OutcomeTokenPriceAdapter; USDC: Kuru's own). */
  priceFeed: Address | null;
  priceFeedCreated: boolean;
  enabledInAccountCore: boolean;
  whitelistedInSpotRouter: boolean;
  priceSource: Address | null;
}

export interface KuruRequest {
  market: Address;
  marketNumber: number;
  stack: string;
  question: string | null;
  phase: string;
  ruleMet: boolean | null;
  pool: { yesUsdc: string; noUsdc: string; stakers: number };
  status: RequestStatus;
  tokens: { yes: TokenSetup; usdc: TokenSetup };
  deploySpotMarket: Record<string, string | number>;
  expectedBook: Address;
  bookDeployed: boolean;
  bookProblem: string | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const usdcText = (x: bigint) => (Number(x) / 1e6).toFixed(2);

async function requestFor(deps: ApiDeps, m: MarketInfo): Promise<KuruRequest | null> {
  const stack = stackNamed(deps.deployment, m.stack ?? "primary");
  const kuru = deps.deployment.external.kuruV2;
  const graduator = stack?.contracts.graduator;
  if (!stack || !kuru || !graduator) return null;
  const client = deps.sdk.context.publicClient;
  const feeds = stack.contracts.periphery?.kuruFeedFactory;
  const [request, expected, registered] = await Promise.all([
    client.readContract({
      address: graduator,
      abi: graduatorV2Abi,
      functionName: "bookRequest",
      args: [m.address],
    }),
    client.readContract({
      address: graduator,
      abi: graduatorV2Abi,
      functionName: "predictedBook",
      args: [m.address],
    }),
    client.readContract({
      address: graduator,
      abi: graduatorV2Abi,
      functionName: "bookOf",
      args: [m.address],
    }),
  ]);
  if (registered !== ZERO) return null;
  const code = await client.getCode({ address: expected });
  const deployed = code !== undefined && code !== "0x";
  const problemCode = deployed
    ? await client.readContract({
        address: graduator,
        abi: graduatorV2Abi,
        functionName: "bookProblem",
        args: [m.address, expected],
      })
    : null;
  const limiter = kuru.withdrawalLimiter;
  const setup = async (token: Address, feed: Address | null, created: boolean): Promise<TokenSetup> => {
    const [config, whitelisted, source] = await Promise.all([
      client.readContract({
        address: kuru.accountCore,
        abi: kuruV2AccountCoreAbi,
        functionName: "spotTokenConfigs",
        args: [token],
      }),
      client.readContract({
        address: kuru.spotRouter,
        abi: kuruV2SpotRouterAbi,
        functionName: "whitelistedSpotTokens",
        args: [token],
      }),
      limiter
        ? client.readContract({
            address: limiter,
            abi: kuruV2WithdrawalLimiterAbi,
            functionName: "priceSource",
            args: [token],
          })
        : Promise.resolve(ZERO as Address),
    ]);
    return {
      token,
      priceFeed: feed,
      priceFeedCreated: created,
      enabledInAccountCore: config[1],
      whitelistedInSpotRouter: whitelisted,
      priceSource: source === ZERO ? null : source,
    };
  };
  let yesFeed: Address | null = null;
  let yesFeedCreated = false;
  if (feeds) {
    const [predicted, existing] = await Promise.all([
      client.readContract({
        address: feeds,
        abi: outcomeTokenPriceAdapterFactoryAbi,
        functionName: "predictAdapter",
        args: [m.address, 0],
      }),
      client.readContract({
        address: feeds,
        abi: outcomeTokenPriceAdapterFactoryAbi,
        functionName: "adapterOf",
        args: [m.address, 0],
      }),
    ]);
    yesFeed = predicted;
    yesFeedCreated = existing !== ZERO;
  }
  const [yes, usdc] = await Promise.all([
    setup(request.baseToken, yesFeed, yesFeedCreated),
    setup(request.quoteToken, null, false),
  ]);
  const tokensReady = (t: TokenSetup) =>
    t.enabledInAccountCore && t.whitelistedInSpotRouter && t.priceSource !== null;
  const status: RequestStatus =
    !tokensReady(yes) || !tokensReady(usdc)
      ? "needs-token-setup"
      : !deployed
        ? "needs-book"
        : problemCode === 0
          ? "ready-to-register"
          : "book-not-registrable";
  return {
    market: m.address,
    marketNumber: m.id,
    stack: stack.name,
    question: m.rule,
    phase: m.phaseName,
    ruleMet: m.graduationRuleMet,
    pool: { yesUsdc: usdcText(m.pool.yes), noUsdc: usdcText(m.pool.no), stakers: m.pool.stakers },
    status,
    tokens: { yes, usdc },
    deploySpotMarket: {
      baseToken: request.baseToken,
      quoteToken: request.quoteToken,
      sizePrecision: request.sizePrecision.toString(),
      pricePrecision: request.pricePrecision,
      tickSize: request.tickSize,
      passiveSpreadTicks: request.passiveSpreadTicks,
      minQuoteNotional: request.minQuoteNotional.toString(),
      maxQuoteNotional: request.maxQuoteNotional.toString(),
      takerFeePps: request.takerFeePps.toString(),
      makerFeePps: request.makerFeePps.toString(),
    },
    expectedBook: expected,
    bookDeployed: deployed,
    bookProblem: problemCode === null ? null : (PROBLEMS[problemCode] ?? `problem ${problemCode}`),
  };
}

/** Every v2 pool market without a registered book, oldest first (the order Kuru should work through). */
export async function kuruRequests(deps: ApiDeps): Promise<{ network: string; requests: KuruRequest[] }> {
  return cached(
    `kuru-requests:${deps.network}`,
    30_000,
    async () => {
      const markets = (await allMarkets(deps)).filter((m) => m.kuruVersion === 2 && m.phase === Phase.Pool);
      const requests = (await Promise.all(markets.map((m) => requestFor(deps, m)))).flatMap((r) =>
        r ? [r] : [],
      );
      return { network: deps.network, requests: requests.sort((a, b) => a.marketNumber - b.marketNumber) };
    },
    deps.now(),
  );
}

export async function getKuruRequests(_request: Request, deps: ApiDeps): Promise<Response> {
  const kuru = deps.deployment.external.kuruV2;
  if (!kuru)
    return problem(404, `There is no Kuru v2 deployment on ${deps.network} in the deployments file yet.`);
  try {
    const body = await kuruRequests(deps);
    return json(
      {
        ...body,
        kuru: {
          spotRouter: kuru.spotRouter,
          accountCore: kuru.accountCore,
          withdrawalLimiter: kuru.withdrawalLimiter ?? null,
        },
        howToUse:
          "For each request: set the YES token's price source (over tokens.yes.priceFeed, a Chainlink AggregatorV3 feed with 8 decimals), enable and whitelist it (and USDC if not done), then call deploySpotMarket with exactly these arguments. The book lands at expectedBook, and Hunch Book's keeper registers it.",
      },
      CACHE.recent,
    );
  } catch (e) {
    return problem(502, `Could not read the chain right now: ${e instanceof Error ? e.message : String(e)}`);
  }
}
