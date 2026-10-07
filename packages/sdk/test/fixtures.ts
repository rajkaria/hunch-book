import {
  chainlinkAggregatorAbi,
  chainlinkLatestRoundAbi,
  deployments,
  hunchBookFactoryAbi,
  kuruOrderBookAbi,
  type L2Level,
  marketAbi,
  marketKey,
  Outcome,
  type Phase,
  perplExchangeAbi,
  resolverAbi,
  type Window,
} from "@hunch-book/shared";
import {
  type Abi,
  type Address,
  concat,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  numberToHex,
  pad,
  parseAbi,
  zeroAddress,
} from "viem";
import { perplResolverAbi } from "../src/settlement/perpl.js";
import { type FakeChain, Revert } from "./fake-chain.js";

// A small fake Hunch Book on the fake chain: the testnet factory address, markets with every view the
// SDK reads, resolvers whose `resolve` the test controls, outcome tokens, Kuru books, Chainlink feeds
// and a Perpl exchange.

export const testnet = deployments["monad-testnet"];
export const FACTORY = testnet.hunchBook.factory as Address;
export const VAULT = testnet.hunchBook.vault as Address;
export const USDC = testnet.hunchBook.usdc as Address;
export const ROUTER = testnet.hunchBook.router as Address;

export const addr = (n: number): Address => getAddress(pad(numberToHex(n), { size: 20 }));

export const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

export interface FakeMarket {
  address: Address;
  id: number;
  templateId: number;
  params: Hex;
  phase: Phase;
  outcome?: Outcome;
  window: Window;
  pool?: { yes: bigint; no: bigint; stakers: number };
  tokens?: { yes: Address; no: Address };
  book?: Address | null;
  resolver: Address;
  evidenceHash?: Hex;
  graduated?: boolean;
  creator?: Address;
  ruleMet?: boolean;
}

export const RULE = { minPool: 500_000_000n, minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 };
export const CAPS = {
  poolCap: 5_000_000_000n,
  walletCap: 1_000_000_000n,
  minStake: 1_000_000n,
  creatorMinStake: 5_000_000n,
};

/** Balances per token per holder, shared by every fake ERC-20. */
export class Ledger {
  readonly balances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  set(token: Address, holder: Address, amount: bigint): void {
    this.balances.set(`${token}-${holder}`.toLowerCase(), amount);
  }
  balance(token: Address, holder: Address): bigint {
    return this.balances.get(`${token}-${holder}`.toLowerCase()) ?? 0n;
  }
  allowance(token: Address, owner: Address, spender: Address): bigint {
    return this.allowances.get(`${token}-${owner}-${spender}`.toLowerCase()) ?? 0n;
  }
  approve(token: Address, owner: Address, spender: Address, amount: bigint): void {
    this.allowances.set(`${token}-${owner}-${spender}`.toLowerCase(), amount);
  }
}

export function registerToken(chain: FakeChain, token: Address, ledger: Ledger, name = "Token"): void {
  chain.register(
    token,
    [
      ...erc20Abi,
      ...parseAbi([
        "function version() view returns (string)",
        "function nonces(address) view returns (uint256)",
      ]),
    ],
    {
      balanceOf: ([who]) => ledger.balance(token, who as Address),
      allowance: ([owner, spender]) => ledger.allowance(token, owner as Address, spender as Address),
      approve: ([spender, amount], { from }) => {
        if (from) ledger.approve(token, from, spender as Address, amount as bigint);
        return true;
      },
      name: () => name,
      symbol: () => "TKN",
      decimals: () => 6,
      version: () => "1",
      nonces: () => 0n,
    },
  );
}

/** The factory, with these markets in creation order. */
export function registerFactory(chain: FakeChain, markets: FakeMarket[]): void {
  chain.register(FACTORY, hunchBookFactoryAbi, {
    marketCount: () => BigInt(markets.length),
    marketAt: ([i]) => {
      const m = markets[Number(i as bigint)];
      if (!m) throw new Revert(hunchBookFactoryAbi, "UnknownTemplate");
      return m.address;
    },
    isMarket: ([a]) => markets.some((m) => isAddressEqual(m.address, a as Address)),
    marketOf: ([key]) =>
      markets.find((m) => marketKey(m.templateId, m.params) === key)?.address ?? zeroAddress,
    vault: () => VAULT,
    usdc: () => USDC,
    createMarket: () => addr(0xbeef),
  });
}

export function registerMarket(chain: FakeChain, m: FakeMarket): void {
  const pool = m.pool ?? { yes: 0n, no: 0n, stakers: 0 };
  const tokens = m.tokens ?? { yes: addr(m.id * 16 + 1), no: addr(m.id * 16 + 2) };
  chain.register(m.address, marketAbi, {
    phase: () => m.phase,
    poolTotals: () => [pool.yes, pool.no, pool.stakers],
    window: () => m.window,
    tokens: () => [tokens.yes, tokens.no],
    book: () => m.book ?? zeroAddress,
    outcome: () => m.outcome ?? Outcome.Unresolved,
    templateId: () => m.templateId,
    params: () => m.params,
    resolver: () => m.resolver,
    caps: () => CAPS,
    rule: () => RULE,
    creator: () => m.creator ?? addr(0xc0),
    graduated: () => m.graduated ?? false,
    evidenceHash: () => m.evidenceHash ?? ZERO_HASH,
    marketId: () => BigInt(m.id),
    graduationRuleMet: () => m.ruleMet ?? false,
    factory: () => FACTORY,
    stakeOf: () => [0n, 0n],
    claimableTokens: () => [0n, 0n],
    claimablePool: () => [0n, 0n],
    stake: () => undefined,
    stakeWithAuthorization: () => undefined,
    settle: () => undefined,
    proveYes: () => undefined,
    claimTokens: () => undefined,
    claimPool: () => undefined,
    graduate: () => undefined,
  });
}

export type ResolveFn = (params: Hex, evidence: Hex, value: bigint) => readonly [number, Hex];

export function registerResolver(
  chain: FakeChain,
  resolver: Address,
  resolve: ResolveFn,
  extra: { exchange?: Address; challengeBlocks?: bigint; describe?: string } = {},
): void {
  chain.register(
    resolver,
    [...resolverAbi, ...perplResolverAbi, ...parseAbi(["function pyth() view returns (address)"])] as Abi,
    {
      describe: () => extra.describe ?? "YES if the test says so.",
      resolve: ([params, evidence], { value }) => resolve(params as Hex, evidence as Hex, value),
      earlyYes: () => false,
      exchange: () => extra.exchange ?? testnet.external.perpl.exchange,
      challengeBlocks: () => extra.challengeBlocks ?? 100n,
      versionUnchanged: () => true,
      pyth: () => testnet.external.pyth.contract,
    },
  );
}

/** Kuru's getL2Book() bytes: [block][bid price, size]... [0][ask price, size]... */
export function encodeL2Book(block: bigint, bids: L2Level[], asks: L2Level[]): Hex {
  const word = (v: bigint): Hex => pad(numberToHex(v), { size: 32 });
  return concat([
    word(block),
    ...bids.flatMap((l) => [word(l.price), word(l.size)]),
    word(0n),
    ...asks.flatMap((l) => [word(l.price), word(l.size)]),
  ]);
}

export function registerBook(
  chain: FakeChain,
  book: Address,
  yes: Address,
  levels: { bids: L2Level[]; asks: L2Level[] },
): void {
  chain.register(book, kuruOrderBookAbi, {
    getL2Book: () => encodeL2Book(chain.block.number, levels.bids, levels.asks),
    getMarketParams: () => [
      1_000_000,
      1_000_000n,
      yes,
      6n,
      USDC,
      6n,
      1_000,
      1_000_000n,
      5_000_000_000n,
      0n,
      0n,
    ],
    bestBidAsk: () => [
      levels.bids[0] ? levels.bids[0].price * 10n ** 12n : 2n ** 256n - 1n,
      levels.asks[0] ? levels.asks[0].price * 10n ** 12n : 0n,
    ],
  });
}

export interface FakeRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound?: bigint;
}

/** A Chainlink proxy with these rounds (all in one phase); decimals from its phase aggregator. */
export function registerFeed(
  chain: FakeChain,
  feed: Address,
  rounds: FakeRound[],
  decimals = 8,
): { aggregator: Address } {
  const aggregator = addr(Number(BigInt(feed) % 100_000n) + 900_000);
  const byId = new Map(rounds.map((r) => [r.roundId, r]));
  const latest = (): FakeRound => {
    const visible = rounds.filter((r) => r.updatedAt <= chain.block.timestamp);
    return visible.reduce((a, b) => (b.roundId > a.roundId ? b : a));
  };
  chain.register(feed, [...chainlinkAggregatorAbi, ...chainlinkLatestRoundAbi] as Abi, {
    getRoundData: ([id]) => {
      const r = byId.get(id as bigint);
      if (!r || r.updatedAt > chain.block.timestamp) return [id, 0n, 0n, 0n, 0n];
      return [r.roundId, r.answer, r.updatedAt, r.updatedAt, r.answeredInRound ?? r.roundId];
    },
    latestRoundData: () => {
      const r = latest();
      return [r.roundId, r.answer, r.updatedAt, r.updatedAt, r.answeredInRound ?? r.roundId];
    },
    phaseAggregators: () => aggregator,
    decimals: () => decimals,
    description: () => "BTC / USD",
  });
  chain.register(aggregator, chainlinkAggregatorAbi, { decimals: () => decimals });
  return { aggregator };
}

/** Rounds 1..n of phase `phase`, `step` seconds apart from `start`, with answers from `price(i)`. */
export function makeRounds(
  phase: bigint,
  n: number,
  start: bigint,
  step: bigint,
  price: (i: number) => bigint,
): FakeRound[] {
  return Array.from({ length: n }, (_, k) => ({
    roundId: (phase << 64n) | BigInt(k + 1),
    answer: price(k + 1),
    updatedAt: start + BigInt(k) * step,
  }));
}

export interface FundingEvent {
  block: bigint;
  sum: bigint;
}

/** A Perpl exchange whose funding history is this list of events (ascending blocks). */
export function registerPerpl(
  chain: FakeChain,
  exchange: Address,
  events: FundingEvent[],
  interval = 100n,
): void {
  chain.register(exchange, perplExchangeAbi, {
    getFundingSumAtBlock: ([, b]) => {
      let found: FundingEvent | undefined;
      for (const e of events) if (e.block <= (b as bigint)) found = e;
      return found ? [Number(found.sum), found.block] : [0, 0n];
    },
    getFundingInterval: () => interval,
  });
}

export const blockWindow = (lock: bigint, close: bigint, deadline: bigint): Window => ({
  blockClock: true,
  lock,
  close,
  settleDeadline: deadline,
});

export const timeWindow = (lock: bigint, close: bigint, deadline: bigint): Window => ({
  blockClock: false,
  lock,
  close,
  settleDeadline: deadline,
});
