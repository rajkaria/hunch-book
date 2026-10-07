import { type Deployment, deployments } from "@hunch-book/shared";
import { render, screen, within } from "@testing-library/react";
import { type Address, type Hex, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TxList } from "../src/components/market/TxList";
import { FillTable } from "../src/components/tape/FillTable";
import { windowText } from "../src/components/tape/TapeView";
import type { TradeRow } from "../src/lib/indexer/queries";
import {
  type BookInfo,
  blockRanges,
  type Fill,
  fillFromLog,
  fillFromRow,
  isBetweenOthers,
  type TapeClient,
  TapeScanner,
  type TradeLog,
  tapeStats,
} from "../src/lib/tape/fills";
import { formatAgo, formatClockUtc, formatPriceE6 } from "../src/lib/tape/format";
import { clearTxTimings, recordTxTiming, type TxTiming, txTiming } from "../src/lib/wallet/txTiming";
import { USDC, USER } from "./fixtures";

const dep: Deployment = deployments["monad-testnet"];
const ROUTER = dep.hunchBook.router as Address;
const MAKER = dep.wallets.maker;
const BOOK = "0x00000000000000000000000000000000000000bb" as Address;
const MARKET = "0x00000000000000000000000000000000000000a1" as Address;
const STRANGER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;

const books = new Map<string, BookInfo>([
  [BOOK.toLowerCase(), { book: BOOK, market: MARKET, marketNumber: 3, question: "Will BTC close above?" }],
]);

/** A Kuru Trade log: 25 YES at 0.416 USDC. */
function tradeLog(over: Partial<TradeLog["args"]> = {}, at = { block: 100n, index: 4 }): TradeLog {
  return {
    address: BOOK,
    blockNumber: at.block,
    logIndex: at.index,
    transactionHash: TX,
    args: {
      orderId: 9,
      makerAddress: MAKER,
      isBuy: true,
      price: 416_000_000_000_000_000n,
      updatedSize: USDC(75),
      takerAddress: ROUTER,
      txOrigin: STRANGER,
      filledSize: USDC(25),
      ...over,
    },
  };
}

describe("fillFromLog", () => {
  it("reads a router fill against our maker the way the indexer does", () => {
    const fill = fillFromLog(tradeLog(), dep, books);
    expect(fill).toMatchObject({
      id: "100-4",
      market: MARKET,
      marketNumber: 3,
      priceE6: 416_000n,
      size: USDC(25),
      notional: USDC(10.4),
      takerBuysYes: true,
      maker: MAKER,
      trader: STRANGER,
      viaRouter: true,
      makerIsOurMaker: true,
      makerIsOurs: true,
      traderIsOurs: false,
      time: null,
    });
    expect(isBetweenOthers(fill as Fill)).toBe(false);
  });

  it("takes the taker itself as the trader for a direct fill, and labels a fill between others", () => {
    const fill = fillFromLog(
      tradeLog({ makerAddress: OTHER, takerAddress: STRANGER, isBuy: false }),
      dep,
      books,
    );
    expect(fill).toMatchObject({ trader: STRANGER, viaRouter: false, takerBuysYes: false });
    expect(fill?.makerIsOurMaker).toBe(false);
    expect(isBetweenOthers(fill as Fill)).toBe(true);
  });

  it("labels our keeper as ours, and skips a malformed log", () => {
    const keeper = fillFromLog(tradeLog({ takerAddress: dep.wallets.keeper }), dep, books);
    expect(keeper?.traderIsOurs).toBe(true);
    expect(fillFromLog({ ...tradeLog(), blockNumber: null }, dep, books)).toBeNull();
    expect(fillFromLog(tradeLog({ price: undefined }), dep, books)).toBeNull();
  });
});

describe("fillFromRow", () => {
  it("maps an indexer Trade row", () => {
    const row: TradeRow = {
      id: "68000000-2",
      block: "68000000",
      timestamp: "1791096632",
      tx: TX,
      logIndex: 2,
      priceE6: "620000",
      size: "5000000",
      notional: "3100000",
      takerBuysYes: false,
      maker: MAKER.toLowerCase(),
      taker: ROUTER.toLowerCase(),
      trader: STRANGER.toLowerCase(),
      viaRouter: true,
      isOurMaker: true,
      makerIsOurs: true,
      traderIsOurs: false,
      betweenOthers: false,
      book: { id: BOOK },
      market: { id: MARKET, number: 3, question: null },
    };
    expect(fillFromRow(row)).toMatchObject({
      block: 68_000_000n,
      time: 1_791_096_632,
      priceE6: 620_000n,
      size: USDC(5),
      notional: USDC(3.1),
      maker: MAKER,
      trader: STRANGER,
      makerIsOurMaker: true,
      makerKnown: true,
      marketNumber: 3,
    });
    // A Kuru v2 swap: the indexer marks the maker unknown (zero address); older rows lack the field.
    const swap = { ...row, maker: zeroAddress, isOurMaker: false, makerIsOurs: false, betweenOthers: false };
    expect(fillFromRow({ ...swap, makerKnown: false }).makerKnown).toBe(false);
    expect(fillFromRow(swap).makerKnown).toBe(false);
    expect(isBetweenOthers(fillFromRow(swap))).toBe(false);
  });
});

describe("blockRanges", () => {
  it("covers a span with ranges of at most 100 blocks, newest first", () => {
    expect(blockRanges(0n, 250n)).toEqual([
      { from: 151n, to: 250n },
      { from: 51n, to: 150n },
      { from: 0n, to: 50n },
    ]);
    expect(blockRanges(10n, 10n)).toEqual([{ from: 10n, to: 10n }]);
    expect(blockRanges(11n, 10n)).toEqual([]);
  });
});

/** A fake chain holding Kuru Trade logs by block. */
function fakeChain(head: bigint, logs: TradeLog[]) {
  const state = { head };
  const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
    expect(toBlock - fromBlock).toBeLessThan(100n);
    return logs.filter((l) => (l.blockNumber as bigint) >= fromBlock && (l.blockNumber as bigint) <= toBlock);
  });
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
    number: blockNumber,
    timestamp: 1_000n + blockNumber,
  }));
  const client = {
    getBlockNumber: vi.fn(async () => state.head),
    getLogs,
    getBlock,
  } as unknown as TapeClient;
  return { client, state, getLogs, getBlock };
}

describe("TapeScanner", () => {
  it("backfills, then reads only new blocks, and reads further back on request", async () => {
    const logs = [
      tradeLog({}, { block: 9_500n, index: 1 }),
      tradeLog({}, { block: 9_950n, index: 0 }),
      tradeLog({}, { block: 9_950n, index: 3 }),
      tradeLog({}, { block: 10_020n, index: 0 }),
      tradeLog({}, { block: 8_200n, index: 0 }),
    ];
    const chain = fakeChain(10_000n, logs);
    const scanner = new TapeScanner(chain.client, dep, [...books.values()], { backfill: 1_000n });
    const first = await scanner.poll();
    expect(first.from).toBe(9_001n);
    expect(first.to).toBe(10_000n);
    expect(chain.getLogs).toHaveBeenCalledTimes(10);
    expect(first.fills.map((f) => f.id)).toEqual(["9950-3", "9950-0", "9500-1"]);
    expect(first.fills.map((f) => f.time)).toEqual([10_950, 10_950, 10_500]);
    // One getBlock per block, not per fill.
    expect(chain.getBlock).toHaveBeenCalledTimes(2);

    chain.state.head = 10_030n;
    const second = await scanner.poll();
    expect(chain.getLogs).toHaveBeenCalledTimes(11);
    expect(chain.getLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ fromBlock: 10_001n, toBlock: 10_030n }),
    );
    expect(second.fills[0]?.id).toBe("10020-0");

    // Nothing new: no getLogs.
    await scanner.poll();
    expect(chain.getLogs).toHaveBeenCalledTimes(11);

    const older = await scanner.extend(1_000n);
    expect(older.from).toBe(8_001n);
    expect(older.fills.map((f) => f.id)).toEqual(["10020-0", "9950-3", "9950-0", "9500-1", "8200-0"]);
  });

  it("keeps only the newest fills, and reads nothing without books", async () => {
    const logs = Array.from({ length: 5 }, (_, i) => tradeLog({}, { block: 990n + BigInt(i), index: 0 }));
    const chain = fakeChain(1_000n, logs);
    const scanner = new TapeScanner(chain.client, dep, [...books.values()], { backfill: 100n, keep: 2 });
    expect((await scanner.poll()).fills.map((f) => f.id)).toEqual(["994-0", "993-0"]);

    const none = fakeChain(1_000n, logs);
    const empty = new TapeScanner(none.client, dep, []);
    expect(await empty.poll()).toEqual({ fills: [], from: null, to: null, books: 0 });
    expect(none.getLogs).not.toHaveBeenCalled();
  });
});

describe("tapeStats", () => {
  it("counts fills, our maker's share and fills between others", () => {
    const ours = fillFromLog(tradeLog(), dep, books) as Fill;
    const others = fillFromLog(tradeLog({ makerAddress: OTHER, takerAddress: STRANGER }), dep, books) as Fill;
    expect(tapeStats([ours, ours, others])).toEqual({
      fills: 3,
      ourMakerFills: 2,
      betweenOthers: 1,
      makerUnknown: 0,
      volume: USDC(31.2),
      ourMakerVolume: USDC(20.8),
      ourMakerShareBps: 6_666,
    });
    expect(tapeStats([]).ourMakerShareBps).toBeNull();
    // A Kuru v2 swap (maker unknown) stays out of our maker's share.
    const swap: Fill = { ...others, id: "swap", maker: OTHER, makerKnown: false, makerIsOurs: false };
    expect(tapeStats([ours, swap])).toMatchObject({
      fills: 2,
      ourMakerFills: 1,
      makerUnknown: 1,
      ourMakerShareBps: 10_000,
    });
  });
});

describe("tape formatting", () => {
  it("prints UTC clock times, ages, prices and block windows", () => {
    expect(formatClockUtc(1_791_096_632)).toBe("06:50:32 UTC");
    expect(formatAgo(100, 101)).toBe("now");
    expect(formatAgo(100, 108)).toBe("8s ago");
    expect(formatAgo(100, 400)).toBe("5m ago");
    expect(formatAgo(0, 7_300)).toBe("2h ago");
    expect(formatPriceE6(416_000n)).toBe("0.416");
    expect(formatPriceE6(1_000_000n)).toBe("1.000");
    expect(windowText({ from: 9_001n, to: 10_000n })).toBe(
      "blocks 9,001 to 10,000 (1,000 blocks, about 7 minutes)",
    );
  });
});

describe("transaction timing", () => {
  const timing: TxTiming = {
    hash: TX,
    network: "monad-testnet",
    signedAt: 1_000,
    seenAt: 1_812,
    includedMs: 812,
    block: 100n,
    blockTime: null,
  };

  beforeEach(() => clearTxTimings());
  afterEach(() => clearTxTimings());

  it("keeps each transaction's inclusion time across page loads", () => {
    recordTxTiming(timing);
    expect(txTiming(TX.toUpperCase())?.includedMs).toBe(812);
    const stored = JSON.parse(window.localStorage.getItem("hunch-book:tx-timings") ?? "[]");
    expect(stored[0]).toMatchObject({ hash: TX, includedMs: 812, block: "100" });
  });

  it("shows it on the tape and in the list of sent transactions", () => {
    const fill = fillFromLog(tradeLog({ txOrigin: USER }), dep, books) as Fill;
    render(
      <FillTable
        fills={[{ ...fill, time: 1_791_096_632 }]}
        now={1_791_096_640}
        user={USER}
        timings={new Map([[TX, timing]])}
        caption="fills"
      />,
    );
    const row = screen.getAllByRole("row")[1] as HTMLElement;
    const cells = within(row);
    expect(cells.getByText("Buy YES")).toBeTruthy();
    expect(cells.getByText("Hunch maker (ours)")).toBeTruthy();
    expect(cells.getByText("via router")).toBeTruthy();
    expect(cells.getByText("you")).toBeTruthy();
    expect(cells.getByText("0.416")).toBeTruthy();
    expect(cells.getByText("8s ago")).toBeTruthy();
    expect(cells.getByText("included in 812 ms")).toBeTruthy();
    expect(cells.getByRole("link", { name: "#3 Will BTC close above?" }).getAttribute("href")).toBe(
      `/m/${MARKET}`,
    );

    const list = render(
      <TxList txs={[{ hash: TX, label: "Buy YES", status: "confirmed", includedMs: 812, block: 100n }]} />,
    );
    expect(within(list.container).getByText(/included in 812 ms/)).toBeTruthy();
  });
});
