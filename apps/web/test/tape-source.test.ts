import { deployments } from "@hunch-book/shared";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexerClient } from "../src/lib/indexer/client";
import type { TradeRow } from "../src/lib/indexer/queries";
import type { TradeLog } from "../src/lib/tape/fills";
import { readTape } from "../src/lib/tape/hooks";

// readTape picks its source: the indexer's Trade rows when one is configured and answers, else
// Kuru's events from recent blocks. Both paths filter by market and to fills between other parties.

const BOOK = "0x00000000000000000000000000000000000000bb" as Address;
const MARKET = "0x00000000000000000000000000000000000000a1" as Address;
const OTHER_MARKET = "0x00000000000000000000000000000000000000a2" as Address;
const STRANGER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;

const mocked = vi.hoisted(() => ({
  indexer: null as IndexerClient | null,
  logs: [] as unknown[],
}));

vi.mock("../src/lib/indexer/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/indexer/client")>();
  return { ...actual, getIndexerClient: () => mocked.indexer };
});

vi.mock("../src/lib/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chain/client")>();
  return {
    ...actual,
    getPublicClient: () => ({
      getBlockNumber: async () => 5_000n,
      getLogs: async () => mocked.logs,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        timestamp: 100n,
      }),
    }),
  };
});

const log = (maker: Address, block: bigint): TradeLog => ({
  address: BOOK,
  blockNumber: block,
  logIndex: 0,
  transactionHash: TX,
  args: {
    orderId: 1,
    makerAddress: maker,
    isBuy: true,
    price: 500_000_000_000_000_000n,
    updatedSize: 0n,
    takerAddress: STRANGER,
    txOrigin: STRANGER,
    filledSize: 1_000_000n,
  },
});

const row: TradeRow = {
  id: "10-0",
  block: "10",
  timestamp: "100",
  tx: TX,
  logIndex: 0,
  priceE6: "500000",
  size: "1000000",
  notional: "500000",
  takerBuysYes: true,
  maker: OTHER.toLowerCase(),
  taker: STRANGER.toLowerCase(),
  trader: STRANGER.toLowerCase(),
  viaRouter: false,
  isOurMaker: false,
  makerIsOurs: false,
  traderIsOurs: false,
  betweenOthers: true,
  book: { id: BOOK },
  market: { id: MARKET, number: 1, question: null },
};

beforeEach(() => {
  mocked.indexer = null;
  mocked.logs = [];
});

describe("readTape", () => {
  it("asks the indexer for one market's fills between other parties", async () => {
    const query = vi.fn(async () => ({ Trade: [row] }));
    mocked.indexer = {
      url: "https://indexer.example",
      network: "monad-testnet",
      chainId: 10143,
      query,
      status: async () => null,
      available: () => true,
    } as unknown as IndexerClient;
    const tape = await readTape({ market: MARKET, books: [], limit: 20, othersOnly: true });
    expect(tape.source).toBe("indexer");
    expect(tape.data.fills.map((f) => f.id)).toEqual(["10-0"]);
    expect(query).toHaveBeenCalledWith(expect.any(String), {
      where: { market_id: { _eq: MARKET.toLowerCase() }, betweenOthers: { _eq: true } },
      limit: 20,
    });
  });

  it("reads recent blocks without an indexer, and filters the same way", async () => {
    mocked.logs = [log(deployments["monad-testnet"].wallets.maker, 4_990n), log(OTHER, 4_995n)];
    const books = [
      { book: BOOK, market: MARKET, marketNumber: 1, question: null },
      {
        book: "0x00000000000000000000000000000000000000bc" as Address,
        market: OTHER_MARKET,
        marketNumber: 2,
        question: null,
      },
    ];
    const all = await readTape({ books, limit: 50 });
    expect(all.source).toBe("chain");
    expect(all.data.fills.map((f) => f.block)).toEqual([4_995n, 4_990n]);
    expect(all.data.window).toEqual({ from: 4_001n, to: 5_000n });
    expect(all.data.books).toBe(2);

    const others = await readTape({ books, limit: 50, othersOnly: true });
    expect(others.data.fills.map((f) => f.block)).toEqual([4_995n]);
    const elsewhere = await readTape({ market: OTHER_MARKET, books, limit: 50 });
    expect(elsewhere.data.fills).toEqual([]);
  });
});
