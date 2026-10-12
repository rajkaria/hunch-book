import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/health/[service]/route";

// GET /api/health/<service>?network=<network>: each network's keeper and maker have their own health
// URL. The fetch is stubbed; the route must pick the network's variable and never another network's.

const call = (path: string, service: string) =>
  GET(new Request(`https://book.playhunch.xyz${path}`), { params: Promise.resolve({ service }) });

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ lastCycleAt: "2026-10-12T03:00:00Z" })));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  for (const name of [
    "KEEPER_HEALTH_URL",
    "MAKER_HEALTH_URL",
    "KEEPER_HEALTH_URL_MAINNET",
    "MAKER_HEALTH_URL_MAINNET",
    "NEXT_PUBLIC_KEEPER_HEALTH_URL",
    "NEXT_PUBLIC_MAKER_HEALTH_URL",
    "NEXT_PUBLIC_KEEPER_HEALTH_URL_MAINNET",
    "NEXT_PUBLIC_MAKER_HEALTH_URL_MAINNET",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

describe("GET /api/health/[service]", () => {
  it("fetches the network's own health URL", async () => {
    vi.stubEnv("KEEPER_HEALTH_URL", "https://keeper-testnet.example/health");
    vi.stubEnv("KEEPER_HEALTH_URL_MAINNET", "https://keeper-mainnet.example/health");
    const testnet = await (await call("/api/health/keeper?network=monad-testnet", "keeper")).json();
    expect(testnet).toMatchObject({ service: "keeper", configured: true, reachable: true });
    expect(fetchMock).toHaveBeenLastCalledWith("https://keeper-testnet.example/health", expect.anything());
    await call("/api/health/keeper?network=monad-mainnet", "keeper");
    expect(fetchMock).toHaveBeenLastCalledWith("https://keeper-mainnet.example/health", expect.anything());
  });

  it("says not configured, and fetches nothing, when the network has no URL", async () => {
    vi.stubEnv("MAKER_HEALTH_URL", "https://maker-testnet.example/health");
    const res = await call("/api/health/maker?network=monad-mainnet", "maker");
    expect(await res.json()).toEqual({ service: "maker", configured: false, reachable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown service or network", async () => {
    expect((await call("/api/health/indexer", "indexer")).status).toBe(404);
    expect((await call("/api/health/keeper?network=base", "keeper")).status).toBe(400);
  });
});
