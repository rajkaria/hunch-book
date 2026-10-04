import { Outcome, Phase } from "@hunch-book/shared";
import { type Address, getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { bindActive, mergeScans, scanBinds, scanWindows } from "../src/lib/referral/binds";
import { CARD_COLORS, fitQuestion, phaseColor, shareCard } from "../src/lib/referral/card";
import {
  estimateCredit,
  fetchFeeEvents,
  PLANNED_REFERRAL_SHARE_BPS,
  protocolShare,
  referralCredit,
} from "../src/lib/referral/earnings";
import { marketInPath, marketUrl, referralPath, referralUrl, safeNextPath } from "../src/lib/referral/link";
import {
  clearReferrer,
  dismissReferrer,
  type KeyValueStore,
  memoryStore,
  REFERRER_KEY,
  REFERRER_TTL_MS,
  readReferrer,
  saveReferrer,
} from "../src/lib/referral/storage";
import { MARKET, makeMarket, USDC, USER } from "./fixtures";

const REFERRER = getAddress("0x00000000000000000000000000000000000000d7");
const REGISTRY = "0x00000000000000000000000000000000000000e7" as Address;
const T = 1_799_000_000_000;

describe("referrer storage", () => {
  it("remembers a referrer from a link, checksummed, and reads it back", () => {
    const store = memoryStore();
    expect(saveReferrer(store, REFERRER.toLowerCase(), T)).toBe("saved");
    expect(readReferrer(store, T + 1_000)).toEqual({ referrer: REFERRER, savedAt: T, dismissed: false });
  });

  it("never stores the visitor's own wallet or something that is not an address", () => {
    const store = memoryStore();
    expect(saveReferrer(store, REFERRER, T, REFERRER)).toBe("self");
    expect(saveReferrer(store, "0x123", T)).toBe("invalid");
    expect(readReferrer(store, T)).toBeNull();
  });

  it("lets the latest link win, but opening the same link again keeps a no-thanks", () => {
    const store = memoryStore();
    saveReferrer(store, REFERRER, T);
    dismissReferrer(store, T);
    expect(readReferrer(store, T)?.dismissed).toBe(true);
    saveReferrer(store, REFERRER, T + 5);
    expect(readReferrer(store, T + 5)).toEqual({ referrer: REFERRER, savedAt: T + 5, dismissed: true });
    saveReferrer(store, USER, T + 6);
    expect(readReferrer(store, T + 6)).toEqual({
      referrer: getAddress(USER),
      savedAt: T + 6,
      dismissed: false,
    });
  });

  it("forgets a referrer after 30 days, and ignores malformed or future records", () => {
    const store = memoryStore();
    saveReferrer(store, REFERRER, T);
    expect(readReferrer(store, T + REFERRER_TTL_MS + 1)).toBeNull();
    expect(store.getItem(REFERRER_KEY)).toBeNull();
    expect(readReferrer(memoryStore({ [REFERRER_KEY]: "{not json" }), T)).toBeNull();
    expect(
      readReferrer(memoryStore({ [REFERRER_KEY]: JSON.stringify({ referrer: "nope", savedAt: T }) }), T),
    ).toBeNull();
    expect(
      readReferrer(
        memoryStore({ [REFERRER_KEY]: JSON.stringify({ referrer: REFERRER, savedAt: T + 3_600_000 }) }),
        T,
      ),
    ).toBeNull();
  });

  it("survives storage that throws, and works without any storage", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readReferrer(broken, T)).toBeNull();
    expect(saveReferrer(broken, REFERRER, T)).toBe("unavailable");
    expect(() => clearReferrer(broken)).not.toThrow();
    expect(saveReferrer(null, REFERRER, T)).toBe("unavailable");
    expect(readReferrer(null, T)).toBeNull();
  });
});

describe("referral links", () => {
  it("builds /r/<referrer> links, with a market to land on", () => {
    expect(referralPath(REFERRER)).toBe(`/r/${REFERRER}`);
    expect(referralPath(REFERRER, `/m/${MARKET}`)).toBe(
      `/r/${REFERRER}?next=${encodeURIComponent(`/m/${MARKET}`)}`,
    );
    expect(referralUrl("https://book.playhunch.xyz/", REFERRER)).toBe(
      `https://book.playhunch.xyz/r/${REFERRER}`,
    );
    expect(marketUrl("https://book.playhunch.xyz", MARKET)).toBe(`https://book.playhunch.xyz/m/${MARKET}`);
  });

  it("only accepts a next page inside this app", () => {
    expect(safeNextPath("/m/0xabc")).toBe("/m/0xabc");
    expect(safeNextPath(["/feed", "/x"])).toBe("/feed");
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil",
      "javascript:alert(1)",
      "",
      " ",
      undefined,
      null,
    ]) {
      expect(safeNextPath(bad as string | undefined), String(bad)).toBeNull();
    }
    expect(safeNextPath(`/${"a".repeat(300)}`)).toBeNull();
    expect(referralPath(REFERRER, "https://evil.example")).toBe(`/r/${REFERRER}`);
  });

  it("finds the market a next path points at, for the share card", () => {
    expect(marketInPath(`/m/${MARKET}`)).toBe(MARKET);
    expect(marketInPath(`/m/${MARKET}?tab=trade`)).toBe(MARKET);
    expect(marketInPath("/markets")).toBeNull();
    expect(marketInPath(null)).toBeNull();
  });
});

describe("bind scans", () => {
  it("walks back from the head in 100-block windows, within a budget, never below the start", () => {
    expect(scanWindows(1_000n, 1_250n)).toEqual([
      { fromBlock: 1_151n, toBlock: 1_250n },
      { fromBlock: 1_051n, toBlock: 1_150n },
      { fromBlock: 1_000n, toBlock: 1_050n },
    ]);
    expect(scanWindows(0n, 10_000n, 100n, 2)).toHaveLength(2);
    expect(scanWindows(50n, 10n)).toEqual([]);
  });

  it("reads Bound events filtered by referrer, newest first, and says how far it got", async () => {
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) =>
      fromBlock === 1_151n
        ? [
            {
              args: { user: USER, referrer: REFERRER, boundAt: 100n, expiresAt: 200n, relayer: USER },
              blockNumber: 1_200n,
              transactionHash: "0xaa",
            },
          ]
        : fromBlock === 1_051n
          ? [
              {
                args: { user: MARKET, referrer: REFERRER, boundAt: 90n, expiresAt: 190n, relayer: MARKET },
                blockNumber: 1_060n,
                transactionHash: "0xbb",
              },
            ]
          : [],
    );
    const scan = await scanBinds({ getLogs } as never, REGISTRY, REFERRER, {
      from: 1_000n,
      to: 1_250n,
      budget: 2,
    });
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ address: REGISTRY, args: { referrer: REFERRER } });
    expect(scan.binds.map((b) => b.tx)).toEqual(["0xaa", "0xbb"]);
    expect(scan).toMatchObject({ scannedFrom: 1_051n, scannedTo: 1_250n, complete: false });

    const older = await scanBinds({ getLogs } as never, REGISTRY, REFERRER, { from: 1_000n, to: 1_050n });
    expect(older.complete).toBe(true);
    const merged = mergeScans(scan, older);
    expect(merged).toMatchObject({ scannedFrom: 1_000n, scannedTo: 1_250n, complete: true });
    expect(merged.binds).toHaveLength(2);
  });

  it("treats a binding as active from boundAt until just before expiresAt", () => {
    const b = { boundAt: 100n, expiresAt: 200n };
    expect(bindActive(b, 99)).toBe(false);
    expect(bindActive(b, 100)).toBe(true);
    expect(bindActive(b, 199)).toBe(true);
    expect(bindActive(b, 200)).toBe(false);
  });
});

describe("referral earnings", () => {
  it("follows the formula: 75% of each fee is the protocol's, the referrer gets the planned 20% of that", () => {
    expect(PLANNED_REFERRAL_SHARE_BPS).toBe(2_000n);
    expect(protocolShare(1_000n)).toBe(750n);
    expect(protocolShare(3n)).toBe(3n); // the creator's 25% rounds down to nothing
    expect(referralCredit(1_000n)).toBe(150n);
    expect(referralCredit(7n, 2_000n)).toBe(1n);
  });

  it("counts only fees paid while the user was bound, per user and in total", () => {
    const binds = [
      { user: USER, boundAt: 100n, expiresAt: 200n },
      { user: MARKET, boundAt: 150n, expiresAt: 250n },
    ];
    const events = [
      { user: USER.toLowerCase(), fee: 1_000n, timestamp: 100n },
      { user: USER.toLowerCase(), fee: 1_000n, timestamp: 200n },
      { user: MARKET.toLowerCase(), fee: 2_000n, timestamp: 160n },
      { user: "0x00000000000000000000000000000000000000ff", fee: 9_000n, timestamp: 160n },
    ];
    const credit = estimateCredit(binds, events);
    expect(credit.total).toBe(450n);
    expect(credit.counted).toBe(2);
    expect(credit.perUser.get(USER.toLowerCase())).toBe(150n);
  });

  it("asks the indexer for redemptions and pool payouts by the referred wallets", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { variables: { users: string[] } };
      expect(body.variables.users).toEqual([USER.toLowerCase()]);
      return new Response(
        JSON.stringify({
          data: {
            Redemption: [{ to: USER.toLowerCase(), fee: "1000", timestamp: "150" }],
            PoolPayout: [
              { wallet_id: USER.toLowerCase(), fee: "40", timestamp: "160" },
              { wallet_id: null, fee: "5", timestamp: "170" },
            ],
          },
        }),
      );
    });
    const events = await fetchFeeEvents("https://indexer.example/v1/graphql", [USER], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(events).toEqual([
      { user: USER.toLowerCase(), fee: 1_000n, timestamp: 150n },
      { user: USER.toLowerCase(), fee: 40n, timestamp: 160n },
    ]);
    expect(await fetchFeeEvents("https://x", [])).toEqual([]);
  });

  it("throws on an indexer error, so the panel can say it is unavailable", async () => {
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ errors: [{ message: "field not found" }] })),
    );
    await expect(
      fetchFeeEvents("https://x", [USER], { fetchImpl: failing as unknown as typeof fetch }),
    ).rejects.toThrow("field not found");
    const down = vi.fn(async () => new Response("", { status: 503 }));
    await expect(
      fetchFeeEvents("https://x", [USER], { fetchImpl: down as unknown as typeof fetch }),
    ).rejects.toThrow("The indexer answered 503.");
  });
});

describe("share card content", () => {
  it("fits long questions with a smaller size and an ellipsis", () => {
    expect(fitQuestion("Short?")).toEqual({ question: "Short?", size: 62 });
    const long = fitQuestion(`${"word ".repeat(60)}end`);
    expect(long.question.length).toBeLessThanOrEqual(180);
    expect(long.question.endsWith("…")).toBe(true);
    expect(long.size).toBe(38);
  });

  it("colours each phase like the app does", () => {
    expect(phaseColor({ phase: Phase.Pool, outcome: Outcome.Unresolved })).toEqual({
      label: "Pool filling",
      color: CARD_COLORS.cyan,
    });
    expect(phaseColor({ phase: Phase.Settled, outcome: Outcome.No }).color).toBe(CARD_COLORS.coral);
    expect(phaseColor({ phase: Phase.Voided, outcome: Outcome.Unresolved }).label).toBe("Voided");
  });

  it("shows a pool market's chance, bar and pool, and a settled one's winner", () => {
    const pool = shareCard(makeMarket(), "Will BTC/USD be at or above $120,000?");
    expect(pool.chance).toEqual({ value: "75.0%", caption: "chance of YES, pool split" });
    expect(pool.yesPct).toBe(75);
    expect(pool.meta).toEqual(["Price at a time", "Market #7", "Pool 400.00 USDC, 4 stakers"]);
    const settled = shareCard(makeMarket({ phase: Phase.Settled, outcome: Outcome.No }), "Q?");
    expect(settled.chance).toEqual({ value: "NO", caption: "won" });
    expect(settled.yesPct).toBe(0);
  });

  it("falls back to a plain card when the market cannot be read", () => {
    const card = shareCard(null, null);
    expect(card.yesPct).toBeNull();
    expect(card.chance.value).toBe("");
    expect(card.question).toMatch(/settles by reading the chain/);
  });

  it("keeps amounts in USDC for the pool line", () => {
    expect(
      shareCard(makeMarket({ pool: { yes: USDC(1), no: 0n, total: USDC(1), stakers: 1 } }), "Q").meta[2],
    ).toBe("Pool 1.00 USDC, 1 staker");
  });
});
