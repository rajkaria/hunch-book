import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadClient } from "../src/lib/chain/client";
import type { MarketsSnapshot } from "../src/lib/chain/reads";
import { measureMsPerBlock, readChainHead, readMarket } from "../src/lib/chain/reads";
import { useMarket } from "../src/lib/hooks";
import { toWireJson } from "../src/lib/served/wire";
import { deployed, marketAddr, marketHandlers, stubClient } from "./chain";
import { makeMarket } from "./fixtures";

// How long a market page waits before it can paint the market, counted in sequential RPC round trips
// from the browser to the public RPC (each one is a full network round trip, and the public RPC is the
// slow part). Each call below answers only when the test advances one round, so the number of rounds a
// read needs is the number of round trips it makes one after the other.

/** A stub client whose calls answer one round at a time; `round()` answers every call waiting now. */
function roundTripClient(base: ReadClient) {
  let waiting: (() => void)[] = [];
  let calls = 0;
  const later =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls++;
      return new Promise<R>((resolve, reject) => {
        waiting.push(() => fn(...args).then(resolve, reject));
      });
    };
  const client = {
    readContract: later(base.readContract as never),
    multicall: later(base.multicall as never),
    getBlock: later(base.getBlock as never),
  } as unknown as ReadClient;
  return {
    client,
    get calls() {
      return calls;
    },
    get waiting() {
      return waiting.length;
    },
    /** Answers every call made so far, then lets the code that awaited them make its next calls. */
    async round() {
      const now = waiting;
      waiting = [];
      for (const answer of now) answer();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

/** Rounds until `work` settles: the read's sequential round trips. */
async function roundsUntil<T>(rt: ReturnType<typeof roundTripClient>, work: Promise<T>): Promise<number> {
  let done = false;
  void work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  let rounds = 0;
  while (!done && rounds < 20) {
    await rt.round();
    rounds++;
  }
  return rounds;
}

const handlers = marketHandlers(2, { describe: () => "Will BTC/USD be at or above $120,000?" });
const blocks = { "2000000": 1_000_003_000n, "1990000": 1_000_000_000n };

describe("round trips before a market page can paint", () => {
  it("before: the chain read of one market takes 2 sequential round trips", async () => {
    const rt = roundTripClient(stubClient(handlers, blocks));
    const rounds = await roundsUntil(rt, readMarket(rt.client, deployed, marketAddr(1)));
    // 1: isMarket on every factory with the market's fields; 2: its rule sentence and book quote.
    expect(rounds).toBe(2);
    expect(rt.calls).toBe(2);
  });

  it("before: the chain clock started only after the market, so times took 2 more", async () => {
    const rt = roundTripClient(stubClient(handlers, blocks));
    const clock = (async () => {
      const head = await readChainHead(rt.client);
      return measureMsPerBlock(rt.client, head.blockNumber);
    })();
    // The head, then the two blocks that measure the pace.
    expect(await roundsUntil(rt, clock)).toBe(2);
  });
});

// ---------- after: the first paint comes from the server's list ----------

const mocked = vi.hoisted(() => ({ client: undefined as unknown as ReadClient }));

vi.mock("@/lib/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chain/client")>();
  return { ...actual, getPublicClient: () => mocked.client };
});

const listed = makeMarket({
  address: marketAddr(1),
  marketId: 2n,
  description: "Will BTC/USD be at or above $120,000?",
});
const served: MarketsSnapshot = {
  list: { status: "ok", data: { markets: [listed], total: 1 } },
  clock: { blockNumber: 2_000_000n, timestamp: 1_000_003_000, msPerBlock: 300, measured: true },
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("round trips before a market page can paint, after", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(toWireJson({ readAt: 1, data: served })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints from the server's list with no RPC round trip, then takes the chain's answer", async () => {
    const rt = roundTripClient(stubClient(handlers, blocks));
    mocked.client = rt.client;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMarket(marketAddr(1)), { wrapper: wrapper(queryClient) });
    // One request to our own server: the market is on screen before any RPC call has answered.
    await waitFor(() => expect(result.current.source).toBe("server"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/read/markets?network=monad-testnet");
    expect(result.current.data).toEqual({ status: "ok", data: listed });
    expect(result.current.servedClock).toEqual(served.clock);
    expect(rt.waiting).toBe(1);
    // The live read still runs, and replaces the server's copy when it lands.
    await act(async () => {
      await rt.round();
      await rt.round();
    });
    await waitFor(() => expect(result.current.source).toBe("chain"));
    expect(result.current.data?.status).toBe("ok");
  });

  it("paints at once, with no request at all, from the list this browser already holds", async () => {
    const rt = roundTripClient(stubClient(handlers, blocks));
    mocked.client = rt.client;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["markets", "monad-testnet"], {
      status: "ok",
      data: { markets: [listed], total: 1, clock: served.clock },
    });
    const { result } = renderHook(() => useMarket(marketAddr(1)), { wrapper: wrapper(queryClient) });
    expect(result.current.source).toBe("server");
    expect(result.current.isPending).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for the chain when the list does not have the market, or the server is down", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("offline");
    });
    const rt = roundTripClient(stubClient(handlers, blocks));
    mocked.client = rt.client;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMarket(marketAddr(0)), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.isPending).toBe(true);
    await act(async () => {
      await rt.round();
      await rt.round();
    });
    await waitFor(() => expect(result.current.source).toBe("chain"));
  });
});
