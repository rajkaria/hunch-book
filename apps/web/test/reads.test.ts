import { Phase } from "@hunch-book/shared";
import { type Address, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  listMarkets,
  measureMsPerBlock,
  readMarket,
  readMarketHeadline,
  readPortfolio,
  readProtocolAddresses,
  readUsdcState,
  readUserPosition,
} from "../src/lib/chain/reads";
import { BOOK, deployed, marketAddr, marketHandlers, notDeployed, stubClient } from "./chain";
import { FACTORY, USDC, USER } from "./fixtures";

describe("listMarkets", () => {
  it("returns not-deployed without touching the chain", async () => {
    const client = stubClient({});
    expect(await listMarkets(client, notDeployed)).toEqual({ status: "not-deployed" });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("lists markets newest first with their rule, pool and book quote", async () => {
    const client = stubClient(marketHandlers(3));
    const result = await listMarkets(client, deployed);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.total).toBe(3);
    expect(result.data.markets.map((m) => m.address)).toEqual([marketAddr(2), marketAddr(1), marketAddr(0)]);
    const graduated = result.data.markets[1];
    expect(graduated?.phase).toBe(Phase.Graduated);
    expect(graduated?.book).toBe(BOOK);
    expect(graduated?.quote).toEqual({ bid: null, ask: 620_000_000_000_000_000n });
    const pool = result.data.markets[0];
    expect(pool?.book).toBeNull();
    expect(pool?.quote).toBeNull();
    expect(pool?.pool).toEqual({ yes: USDC(300), no: USDC(100), total: USDC(400), stakers: 4 });
    expect(pool?.description).toBe("Will BTC/USD be at or above $120,000 at the close?");
    expect(pool?.decoded.kind).toBe("price-at-time");
  });

  it("reads only the newest markets past the limit", async () => {
    const client = stubClient(marketHandlers(5));
    const result = await listMarkets(client, deployed, { limit: 2 });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.total).toBe(5);
    expect(result.data.markets.map((m) => m.address)).toEqual([marketAddr(4), marketAddr(3)]);
  });

  it("returns an empty list when the factory has no markets", async () => {
    const result = await listMarkets(stubClient(marketHandlers(0)), deployed);
    expect(result).toEqual({ status: "ok", data: { markets: [], total: 0 } });
  });

  it("skips a market whose core reads fail, and survives a failing describe", async () => {
    const client = stubClient(
      marketHandlers(2, {
        window: (a) => {
          if (a === marketAddr(0)) throw new Error("revert");
          return { blockClock: false, lock: 1n, close: 2n, settleDeadline: 3n };
        },
        describe: () => {
          throw new Error("revert");
        },
      }),
    );
    const result = await listMarkets(client, deployed);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.markets.map((m) => m.address)).toEqual([marketAddr(1)]);
    expect(result.data.markets[0]?.description).toBeNull();
  });
});

describe("readMarket", () => {
  it("refuses an address the factory does not list", async () => {
    const stranger = "0x1111111111111111111111111111111111111111" as Address;
    expect(await readMarket(stubClient(marketHandlers(1)), deployed, stranger)).toEqual({
      status: "not-market",
    });
  });

  it("reads a listed market", async () => {
    const result = await readMarket(stubClient(marketHandlers(2)), deployed, marketAddr(0));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.marketId).toBe(0n);
  });

  it("throws when the factory cannot be asked, so the page can offer a retry", async () => {
    const client = stubClient(
      marketHandlers(1, {
        isMarket: () => {
          throw new Error("rpc down");
        },
      }),
    );
    await expect(readMarket(client, deployed, marketAddr(0))).rejects.toThrow("rpc down");
  });

  it("is not-deployed without a factory", async () => {
    expect(await readMarket(stubClient({}), notDeployed, marketAddr(0))).toEqual({ status: "not-deployed" });
  });

  it("builds a headline for page metadata, or null", async () => {
    expect(await readMarketHeadline(stubClient(marketHandlers(1)), deployed, marketAddr(0))).toBe(
      "Will BTC/USD be at or above $120,000 at the close?",
    );
    const noDescribe = stubClient(
      marketHandlers(1, {
        describe: () => {
          throw new Error("x");
        },
      }),
    );
    expect(await readMarketHeadline(noDescribe, deployed, marketAddr(0))).toMatch(
      /^Will the asset be at or above/,
    );
    const broken = stubClient(
      marketHandlers(1, {
        isMarket: () => {
          throw new Error("down");
        },
      }),
    );
    expect(await readMarketHeadline(broken, deployed, marketAddr(0))).toBeNull();
  });
});

describe("wallet reads", () => {
  const handlers = marketHandlers(2, {
    stakeOf: (a) => (a === marketAddr(0) ? [USDC(25), 0n] : [0n, 0n]),
    claimableTokens: () => [0n, 0n],
    claimablePool: () => [0n, 0n],
    balanceOf: () => 0n,
    allowance: () => USDC(10),
  });

  it("keeps only markets where the wallet has something", async () => {
    const result = await readPortfolio(stubClient(handlers), deployed, USER);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.market.address).toBe(marketAddr(0));
    expect(result.data[0]?.stake).toEqual({ yes: USDC(25), no: 0n });
  });

  it("reads one position", async () => {
    const p = await readUserPosition(stubClient(handlers), marketAddr(0), USER);
    expect(p.stake.yes).toBe(USDC(25));
  });

  it("reads USDC balance and allowance to the vault", async () => {
    const state = await readUsdcState(
      stubClient({ balanceOf: () => USDC(50), allowance: () => USDC(10) }),
      deployed.hunchBook.usdc as Address,
      deployed.hunchBook.vault as Address,
      USER,
    );
    expect(state).toEqual({ balance: USDC(50), allowance: USDC(10) });
  });

  it("takes the vault and USDC from deployments, and from the factory only when missing", async () => {
    const client = stubClient({
      vault: () => "0x00000000000000000000000000000000000000ee",
      usdc: () => zeroAddress,
    });
    expect(await readProtocolAddresses(client, deployed)).toEqual({
      vault: deployed.hunchBook.vault,
      usdc: deployed.hunchBook.usdc,
    });
    expect(client.readContract).not.toHaveBeenCalled();
    const partial = { ...deployed, hunchBook: { factory: FACTORY, usdc: deployed.hunchBook.usdc } };
    expect((await readProtocolAddresses(client, partial))?.vault).toBe(
      "0x00000000000000000000000000000000000000ee",
    );
    expect(await readProtocolAddresses(client, notDeployed)).toBeNull();
  });
});

describe("measureMsPerBlock", () => {
  it("measures the chain's pace over recent blocks", async () => {
    const client = stubClient({}, { "2000000": 1_000_004_000n, "1990000": 1_000_000_000n });
    expect(await measureMsPerBlock(client, 2_000_000n)).toBe(400);
  });

  it("gives up on a young chain", async () => {
    expect(await measureMsPerBlock(stubClient({}), 5_000n)).toBeNull();
  });
});
