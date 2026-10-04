import {
  collateralVaultAbi,
  type GraduationRule,
  graduatorAbi,
  hunchBookFactoryAbi,
  type MarketCaps,
  marketAbi,
  type Outcome,
  type Phase,
  type Window,
} from "@hunch-book/shared";
import {
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  type PublicClient,
  zeroAddress,
} from "viem";

// Reads Hunch Book markets from the factory (marketCount / marketAt). What never changes for a market
// (template, params, tokens, vault, window, rule, caps, creator, resolver) is read once and cached.
// What changes (phase, pool totals, graduation, outcome, book, unclaimed tokens, pool still owed) is
// re-read every cycle, in one multicall pinned to one block so every market is seen at the same moment.

export interface MarketMeta {
  address: Address;
  templateId: number;
  params: Hex;
  yes: Address;
  no: Address;
  vault: Address;
  window: Window;
  rule: GraduationRule;
  caps: MarketCaps;
  creator: Address;
  resolver: Address;
}

export interface MarketSnapshot extends MarketMeta {
  phase: Phase;
  graduated: boolean;
  outcome: Outcome;
  /** Zero address until the market graduates. */
  book: Address;
  yesTotal: bigint;
  noTotal: bigint;
  stakers: number;
  ruleMet: boolean;
  /** The graduator's book for this market (prepared or registered), or zero. */
  graduatorBook: Address;
  /** YES and NO the market still holds: token claims not yet pulled or pushed. */
  heldYes: bigint;
  heldNo: bigint;
  /** USDC still in the market's pool ledger: pool payouts or refunds not yet claimed. */
  poolOwed: bigint;
}

export interface Globals {
  graduationPaused: boolean;
  graduator: Address;
  canCreateBooks: boolean;
  usdc: Address;
}

const BATCH_BYTES = 16_384;

export async function readGlobals(
  client: PublicClient,
  factory: Address,
  blockNumber: bigint,
): Promise<Globals> {
  const [graduationPaused, graduator, usdc] = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: factory, abi: hunchBookFactoryAbi, functionName: "graduationPaused" },
      { address: factory, abi: hunchBookFactoryAbi, functionName: "graduator" },
      { address: factory, abi: hunchBookFactoryAbi, functionName: "usdc" },
    ],
  });
  const canCreateBooks = isAddressEqual(graduator, zeroAddress)
    ? false
    : await client.readContract({
        address: graduator,
        abi: graduatorAbi,
        functionName: "canCreateBooks",
        blockNumber,
      });
  return { graduationPaused, graduator: getAddress(graduator), canCreateBooks, usdc: getAddress(usdc) };
}

export class MarketDirectory {
  private readonly meta: MarketMeta[] = [];
  /** Markets with nothing left for the keeper to do; never read again by this process. */
  private readonly retired = new Set<Address>();

  constructor(
    private readonly client: PublicClient,
    private readonly factory: Address,
    private readonly allowlist?: Address[],
  ) {}

  get known(): number {
    return this.meta.length;
  }

  retire(address: Address): void {
    this.retired.add(getAddress(address));
  }

  isRetired(address: Address): boolean {
    return this.retired.has(getAddress(address));
  }

  get retiredCount(): number {
    return this.retired.size;
  }

  /** New markets since the last call, then every live market's state at `blockNumber`. */
  async refresh(blockNumber: bigint, graduator: Address): Promise<MarketSnapshot[]> {
    const count = Number(
      await this.client.readContract({
        address: this.factory,
        abi: hunchBookFactoryAbi,
        functionName: "marketCount",
        blockNumber,
      }),
    );
    if (count > this.meta.length) {
      const indices = Array.from({ length: count - this.meta.length }, (_, i) =>
        BigInt(this.meta.length + i),
      );
      const addresses = await this.client.multicall({
        allowFailure: false,
        blockNumber,
        batchSize: BATCH_BYTES,
        contracts: indices.map((i) => ({
          address: this.factory,
          abi: hunchBookFactoryAbi,
          functionName: "marketAt" as const,
          args: [i] as const,
        })),
      });
      for (const address of addresses) this.meta.push(await this.readMeta(getAddress(address), blockNumber));
    }
    const live = this.meta.filter(
      (m) =>
        !this.retired.has(m.address) &&
        (!this.allowlist || this.allowlist.some((a) => isAddressEqual(a, m.address))),
    );
    if (live.length === 0) return [];
    const hasGraduator = !isAddressEqual(graduator, zeroAddress);
    const perMarket = hasGraduator ? 10 : 9;
    const results = await this.client.multicall({
      allowFailure: false,
      blockNumber,
      batchSize: BATCH_BYTES,
      contracts: live.flatMap((m) => {
        const calls = [
          { address: m.address, abi: marketAbi, functionName: "phase" as const },
          { address: m.address, abi: marketAbi, functionName: "poolTotals" as const },
          { address: m.address, abi: marketAbi, functionName: "graduated" as const },
          { address: m.address, abi: marketAbi, functionName: "outcome" as const },
          { address: m.address, abi: marketAbi, functionName: "book" as const },
          { address: m.address, abi: marketAbi, functionName: "graduationRuleMet" as const },
          { address: m.yes, abi: erc20Abi, functionName: "balanceOf" as const, args: [m.address] as const },
          { address: m.no, abi: erc20Abi, functionName: "balanceOf" as const, args: [m.address] as const },
          {
            address: m.vault,
            abi: collateralVaultAbi,
            functionName: "ledger" as const,
            args: [m.address] as const,
          },
        ];
        return hasGraduator
          ? [
              ...calls,
              {
                address: graduator,
                abi: graduatorAbi,
                functionName: "bookOf" as const,
                args: [m.address] as const,
              },
            ]
          : calls;
      }),
    });
    return live.map((m, i) => {
      const r = results.slice(i * perMarket, (i + 1) * perMarket) as unknown[];
      const totals = r[1] as readonly [bigint, bigint, number];
      const ledger = r[8] as { pool: bigint };
      return {
        ...m,
        phase: r[0] as Phase,
        yesTotal: totals[0],
        noTotal: totals[1],
        stakers: Number(totals[2]),
        graduated: r[2] as boolean,
        outcome: r[3] as Outcome,
        book: getAddress(r[4] as Address),
        ruleMet: r[5] as boolean,
        heldYes: r[6] as bigint,
        heldNo: r[7] as bigint,
        poolOwed: ledger.pool,
        graduatorBook: hasGraduator ? getAddress(r[9] as Address) : zeroAddress,
      };
    });
  }

  private async readMeta(address: Address, blockNumber: bigint): Promise<MarketMeta> {
    const [templateId, params, tokens, vault, window, rule, caps, creator, resolver] =
      await this.client.multicall({
        allowFailure: false,
        blockNumber,
        batchSize: BATCH_BYTES,
        contracts: [
          { address, abi: marketAbi, functionName: "templateId" },
          { address, abi: marketAbi, functionName: "params" },
          { address, abi: marketAbi, functionName: "tokens" },
          { address, abi: marketAbi, functionName: "vault" },
          { address, abi: marketAbi, functionName: "window" },
          { address, abi: marketAbi, functionName: "rule" },
          { address, abi: marketAbi, functionName: "caps" },
          { address, abi: marketAbi, functionName: "creator" },
          { address, abi: marketAbi, functionName: "resolver" },
        ],
      });
    return {
      address,
      templateId: Number(templateId),
      params,
      yes: getAddress(tokens[0]),
      no: getAddress(tokens[1]),
      vault: getAddress(vault),
      window: {
        blockClock: window.blockClock,
        lock: BigInt(window.lock),
        close: BigInt(window.close),
        settleDeadline: BigInt(window.settleDeadline),
      },
      rule: {
        minPool: BigInt(rule.minPool),
        minStakers: Number(rule.minStakers),
        minChanceBps: Number(rule.minChanceBps),
        maxChanceBps: Number(rule.maxChanceBps),
      },
      caps: {
        poolCap: BigInt(caps.poolCap),
        walletCap: BigInt(caps.walletCap),
        minStake: BigInt(caps.minStake),
        creatorMinStake: BigInt(caps.creatorMinStake),
      },
      creator: getAddress(creator),
      resolver: getAddress(resolver),
    };
  }
}
