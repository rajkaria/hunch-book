import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/read/[kind]/route";
import { fromWireJson } from "../src/lib/served/wire";

// GET /api/read/<kind>: the route around the server's cached reads, with the reads mocked.

const mocks = vi.hoisted(() => ({
  loadServed: vi.fn(),
  after: vi.fn(),
}));

vi.mock("@/lib/served/load", () => ({ loadServed: mocks.loadServed }));
vi.mock("next/server", () => ({ after: mocks.after }));

const call = (path: string, kind: string) =>
  GET(new Request(`https://book.playhunch.xyz${path}`), { params: Promise.resolve({ kind }) });

beforeEach(() => {
  mocks.loadServed.mockReset();
  mocks.after.mockReset();
});

describe("GET /api/read/[kind]", () => {
  it("answers the cached read with its read time, bigints tagged, and CDN cache headers", async () => {
    mocks.loadServed.mockResolvedValue({
      served: { value: { total: 2n, list: [1n] }, readAt: 1_791_000_000_000 },
      state: "fresh",
    });
    const res = await call("/api/read/markets?network=monad-testnet", "markets");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=15, stale-while-revalidate=60",
    );
    expect(res.headers.get("x-hunch-read")).toBe("fresh");
    expect(fromWireJson(await res.text())).toEqual({
      readAt: 1_791_000_000_000,
      data: { total: 2n, list: [1n] },
    });
    expect(mocks.loadServed).toHaveBeenCalledWith("markets", "monad-testnet");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("keeps a background refresh alive after a stale answer", async () => {
    const refreshing = Promise.resolve();
    mocks.loadServed.mockResolvedValue({ served: { value: 1, readAt: 1 }, state: "stale", refreshing });
    const res = await call("/api/read/proof", "proof");
    expect(res.headers.get("x-hunch-read")).toBe("stale");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    // With no network asked, the build's network is read.
    expect(mocks.loadServed).toHaveBeenCalledWith("proof", "monad-testnet");
  });

  it("refuses unknown reads and networks, and never caches an error", async () => {
    const unknown = await call("/api/read/portfolio", "portfolio");
    expect(unknown.status).toBe(404);
    const network = await call("/api/read/markets?network=ethereum", "markets");
    expect(network.status).toBe(400);
    expect(network.headers.get("cache-control")).toBe("no-store");
    expect(mocks.loadServed).not.toHaveBeenCalled();
  });

  it("answers 503 when the chain cannot be read, so the page reads it directly", async () => {
    mocks.loadServed.mockRejectedValue(new Error("every RPC rate-limited"));
    const res = await call("/api/read/landing?network=monad-testnet", "landing");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await res.text()).error).toMatch(/Could not read the chain/);
  });
});
