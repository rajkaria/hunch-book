import { deployments } from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  creatorFromChain,
  creatorFromIndexer,
  readCreatorFees,
  readCreatorFeesByStack,
} from "../src/lib/creator/read";
import type { CreatorResult } from "../src/lib/indexer/queries";
import { deployed, marketHandlers, notDeployed, stubClient } from "./chain";
import { USDC } from "./fixtures";

const CREATOR = "0x00000000000000000000000000000000000000d1" as Address;
const TX = `0x${"77".repeat(32)}` as Hex;

describe("creatorFromIndexer", () => {
  it("lists the markets with their volume and the creator's share of each one's fees", () => {
    const result: CreatorResult = {
      Creator_by_pk: {
        id: CREATOR,
        isOurs: false,
        marketCount: 2,
        feesAccrued: "2500000",
        feesWithdrawn: "1000000",
        feesOwed: "1500000",
      },
      Market: [
        {
          id: "0x00000000000000000000000000000000000000a2",
          number: 2,
          question: "Will MON close above?",
          stage: "Settled",
          outcome: "No",
          graduated: true,
          poolTotal: "600000000",
          stakerCount: 12,
          volume: "90000000",
          fillCount: 30,
          routerVolume: "40000000",
          createdAt: "1791000000",
          createdTx: TX,
        },
        {
          id: "0x00000000000000000000000000000000000000a1",
          number: 1,
          question: null,
          stage: "Pool",
          outcome: "Unresolved",
          graduated: false,
          poolTotal: "50000000",
          stakerCount: 3,
          volume: "0",
          fillCount: 0,
          routerVolume: "0",
          createdAt: "1790000000",
          createdTx: TX,
        },
      ],
      withdrawals: [{ id: "100-1", amount: "1000000", block: "100", timestamp: "1791500000", tx: TX }],
      accruals: [
        {
          id: "90-0",
          amount: "6000000",
          block: "90",
          timestamp: "1791400000",
          tx: TX,
          market: { id: "0x00000000000000000000000000000000000000a2", number: 2 },
        },
        {
          id: "95-0",
          amount: "4000000",
          block: "95",
          timestamp: "1791450000",
          tx: TX,
          market: { id: "0x00000000000000000000000000000000000000a2", number: 2 },
        },
      ],
    };
    const c = creatorFromIndexer(CREATOR, result);
    expect(c.earned).toBe(USDC(2.5));
    expect(c.withdrawn).toBe(USDC(1));
    expect(c.scanned).toBeNull();
    expect(c.markets[0]).toMatchObject({
      number: 2,
      stage: "Settled NO",
      pool: USDC(600),
      stakers: 12,
      volume: USDC(90),
      fills: 30,
      // 25% of the 6 and 4 USDC fees.
      earned: USDC(2.5),
    });
    expect(c.markets[1]).toMatchObject({ stage: "Pool", earned: 0n });
    expect(c.withdrawals).toEqual([{ amount: USDC(1), time: 1_791_500_000, block: 100n, tx: TX }]);
  });

  it("an address the indexer has never seen is a creator with nothing yet", () => {
    const c = creatorFromIndexer(CREATOR, { Creator_by_pk: null, Market: [], withdrawals: [], accruals: [] });
    expect(c).toMatchObject({ earned: 0n, withdrawn: 0n, markets: [], withdrawals: [] });
  });
});

describe("creatorFromChain", () => {
  it("finds the creator's markets among those the chain lists", async () => {
    const client = stubClient(marketHandlers(3));
    const mine = await creatorFromChain(client, deployed, CREATOR);
    expect(mine.markets).toHaveLength(3);
    expect(mine.markets[0]).toMatchObject({
      number: 2,
      tag: "#2 · Kuru",
      stage: "Pool",
      pool: USDC(400),
      stakers: 4,
      volume: null,
    });
    expect(mine.scanned).toEqual({ covered: 3, total: 3 });
    expect(mine.earned).toBeNull();
    expect(mine.withdrawals).toBeNull();
    expect(mine.isOurs).toBe(false);

    const stranger = await creatorFromChain(client, deployed, "0x1111111111111111111111111111111111111111");
    expect(stranger.markets).toEqual([]);
  });

  it("labels a market created by one of our wallets as ours", async () => {
    const ours = deployments["monad-testnet"].wallets.keeper;
    const client = stubClient(marketHandlers(1, { creator: () => ours }));
    expect((await creatorFromChain(client, deployed, ours)).isOurs).toBe(true);
  });
});

describe("readCreatorFees", () => {
  it("asks the vault what the creator can withdraw now", async () => {
    const readContract = vi.fn(async () => USDC(1.5));
    expect(await readCreatorFees({ readContract } as never, deployed, CREATOR)).toBe(USDC(1.5));
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "creatorFees",
        args: [CREATOR],
        address: deployed.hunchBook.vault,
      }),
    );
    expect(await readCreatorFees({ readContract } as never, notDeployed, CREATOR)).toBeNull();
  });
});

describe("readCreatorFeesByStack", () => {
  it("asks every stack's vault, since each stack's markets pay fees into their own vault", async () => {
    const ownVault = "0x00000000000000000000000000000000000000a7" as Address;
    const twoStacks = {
      ...deployed,
      stacks: {
        hunch: {
          factory: "0x00000000000000000000000000000000000000f7" as Address,
          vault: ownVault,
          venue: {
            kind: "hunch" as const,
            bookFactory: ownVault,
            marginAccount: ownVault,
            bookImplementation: ownVault,
          },
        },
      },
    };
    const readContract = vi.fn(async ({ address }: { address: Address }) =>
      address === ownVault ? USDC(2) : 0n,
    );
    expect(await readCreatorFeesByStack({ readContract } as never, twoStacks, CREATOR)).toEqual([
      { stack: "primary", label: "Kuru", vault: deployed.hunchBook.vault, fees: 0n },
      { stack: "hunch", label: "Hunch order book", vault: ownVault, fees: USDC(2) },
    ]);
    expect(await readCreatorFeesByStack({ readContract } as never, notDeployed, CREATOR)).toEqual([]);
  });
});
