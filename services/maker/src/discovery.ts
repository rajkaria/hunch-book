import { hunchBookFactoryAbi, marketAbi, type Outcome, type Phase, type Window } from "@hunch-book/shared";
import { type Address, getAddress, type Hex, isAddressEqual, type PublicClient, zeroAddress } from "viem";

// Reads Hunch Book markets from the factory: marketCount / marketAt, then each market's views.
// What never changes for a market (template, params, tokens, vault, window) is read once.

export interface MarketMeta {
  address: Address;
  templateId: number;
  params: Hex;
  yes: Address;
  no: Address;
  vault: Address;
  window: Window;
}

export interface MarketView extends MarketMeta {
  phase: Phase;
  /** Zero address until the market graduates and its Kuru book is registered. */
  book: Address;
  outcome: Outcome;
}

export class MarketDirectory {
  private readonly meta: MarketMeta[] = [];

  constructor(
    private readonly client: PublicClient,
    private readonly factory: Address,
    private readonly allowlist?: Address[],
  ) {}

  async refresh(): Promise<MarketView[]> {
    const count = Number(
      await this.client.readContract({
        address: this.factory,
        abi: hunchBookFactoryAbi,
        functionName: "marketCount",
      }),
    );
    if (count > this.meta.length) {
      const indices = Array.from({ length: count - this.meta.length }, (_, i) =>
        BigInt(this.meta.length + i),
      );
      const addresses = await this.client.multicall({
        allowFailure: false,
        contracts: indices.map((i) => ({
          address: this.factory,
          abi: hunchBookFactoryAbi,
          functionName: "marketAt" as const,
          args: [i] as const,
        })),
      });
      for (const address of addresses) this.meta.push(await this.readMeta(getAddress(address)));
    }
    const markets = this.allowlist
      ? this.meta.filter((m) => this.allowlist?.some((a) => isAddressEqual(a, m.address)))
      : this.meta;
    if (markets.length === 0) return [];
    const live = await this.client.multicall({
      allowFailure: false,
      contracts: markets.flatMap((m) => [
        { address: m.address, abi: marketAbi, functionName: "phase" as const },
        { address: m.address, abi: marketAbi, functionName: "book" as const },
        { address: m.address, abi: marketAbi, functionName: "outcome" as const },
      ]),
    });
    return markets.map((m, i) => ({
      ...m,
      phase: live[i * 3] as Phase,
      book: (live[i * 3 + 1] as Address | undefined) ?? zeroAddress,
      outcome: live[i * 3 + 2] as Outcome,
    }));
  }

  private async readMeta(address: Address): Promise<MarketMeta> {
    const [templateId, params, tokens, vault, window] = await this.client.multicall({
      allowFailure: false,
      contracts: [
        { address, abi: marketAbi, functionName: "templateId" },
        { address, abi: marketAbi, functionName: "params" },
        { address, abi: marketAbi, functionName: "tokens" },
        { address, abi: marketAbi, functionName: "vault" },
        { address, abi: marketAbi, functionName: "window" },
      ],
    });
    return {
      address,
      templateId: Number(templateId),
      params,
      yes: tokens[0],
      no: tokens[1],
      vault,
      window: {
        blockClock: window.blockClock,
        lock: BigInt(window.lock),
        close: BigInt(window.close),
        settleDeadline: BigInt(window.settleDeadline),
      },
    };
  }
}

/**
 * Seconds until close, by the market's own clock: blocks × the measured block time for block-clock
 * markets (Perpl), unix seconds otherwise.
 */
export function secondsToClose(
  window: Window,
  now: { block: number; timestamp: number },
  blockSeconds: number,
): number {
  if (window.blockClock) return (Number(window.close) - now.block) * blockSeconds;
  return Number(window.close) - now.timestamp;
}
