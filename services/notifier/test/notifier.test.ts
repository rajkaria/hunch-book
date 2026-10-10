import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deployment, deployments } from "@hunch-book/shared";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCommand, parseCommand, parseTarget } from "../src/commands.js";
import { describeConfig, loadEnvFile, parseConfig, parseEnvFile, secretsOf } from "../src/config.js";
import { diffMarkets, type Remembered, redeemable } from "../src/events.js";
import { setLogSink } from "../src/log.js";
import {
  type MarketState,
  midBps,
  Outcome,
  Phase,
  type Position,
  readMarketsFromChain,
  readMarketsFromIndexer,
} from "../src/markets.js";
import { bookPhrase, chance, eventMessage, redeemMessage } from "../src/messages.js";
import { Notifier } from "../src/notifier.js";
import { emptyState, loadState, parseState, saveState } from "../src/state.js";
import { parseSubscriptions, SubscriptionStore } from "../src/store.js";
import { DryRunMessenger } from "../src/telegram.js";

setLogSink(() => {});

const MARKET = getAddress("0x2a44b99014cf73065bfb89197a08de09d18d3982");
const OTHER = getAddress("0x00000000000000000000000000000000000000a2");
const WALLET = getAddress("0x58369aaed363a59022c98cd457ea5e320df395eb");
const TOKEN = "123456789:AAEhBP0av28Sd4XKpGpT-7RqbzS1N6vR4x0";
const LINKS = { appUrl: "https://book.playhunch.xyz", explorer: "https://testnet.monadscan.com" };

function market(over: Partial<MarketState> = {}): MarketState {
  return {
    address: MARKET,
    marketId: 1,
    phase: Phase.Pool,
    outcome: Outcome.Unresolved,
    graduated: false,
    chanceBps: 6_000,
    poolTotal: 690_000_000n,
    question: "Will BTC longs pay shorts on net between block 1 and block 2?",
    yes: getAddress("0x00000000000000000000000000000000000000c1"),
    no: getAddress("0x00000000000000000000000000000000000000c2"),
    ...over,
  };
}

const position = (over: Partial<Position> = {}): Position => ({
  stakeYes: 0n,
  stakeNo: 0n,
  yes: 0n,
  no: 0n,
  claimableYes: 0n,
  claimableNo: 0n,
  claimablePool: 0n,
  ...over,
});

describe("config", () => {
  it("defaults to a dry run on testnet", () => {
    const c = parseConfig({});
    expect(c).toMatchObject({ network: "monad-testnet", enabled: false, live: false, priceMoveBps: 1_000 });
    expect(c.appUrl).toBe("https://book.playhunch.xyz");
  });

  it("goes live only with the kill switch on and a token set", () => {
    expect(parseConfig({ TELEGRAM_BOT_TOKEN: TOKEN }).live).toBe(false);
    expect(parseConfig({ NOTIFIER_ENABLED: "1" }).live).toBe(false);
    expect(parseConfig({ NOTIFIER_ENABLED: "1", TELEGRAM_BOT_TOKEN: TOKEN }).live).toBe(true);
  });

  it("refuses bad values and never prints the token", () => {
    expect(() => parseConfig({ TELEGRAM_BOT_TOKEN: "nope" })).toThrow(/bot token/);
    expect(() => parseConfig({ NOTIFIER_PRICE_MOVE_BPS: "0" })).toThrow(/NOTIFIER_PRICE_MOVE_BPS/);
    expect(() => parseConfig({ NOTIFIER_NETWORK: "eth" })).toThrow(/NOTIFIER_NETWORK/);
    const c = parseConfig({ TELEGRAM_BOT_TOKEN: TOKEN, NOTIFIER_ENABLED: "yes" });
    expect(JSON.stringify(describeConfig(c))).not.toContain(TOKEN);
    expect(secretsOf(c)).toContain(TOKEN);
  });

  it("loads only its own variables from a .env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "notifier-env-"));
    const file = join(dir, ".env");
    writeFileSync(
      file,
      `TELEGRAM_BOT_TOKEN=${TOKEN}\nKEEPER_PRIVATE_KEY=0xabc\nexport NOTIFIER_POLL_SECONDS="45"\n`,
    );
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFile(file, env).sort()).toEqual(["NOTIFIER_POLL_SECONDS", "TELEGRAM_BOT_TOKEN"]);
    expect(env.KEEPER_PRIVATE_KEY).toBeUndefined();
    expect(parseEnvFile("A=1 # note\nB='x y'")).toEqual({ A: "1", B: "x y" });
  });
});

describe("commands", () => {
  it("parses commands, with or without the bot's name", () => {
    expect(parseCommand("/start")).toEqual({ kind: "start" });
    expect(parseCommand("/watch@HunchBookBot 0xabc")).toEqual({ kind: "watch", arg: "0xabc" });
    expect(parseCommand("/UNWATCH all")).toEqual({ kind: "unwatch", arg: "all" });
    expect(parseCommand("/list")).toEqual({ kind: "list" });
    expect(parseCommand("/foo")).toEqual({ kind: "unknown", name: "foo" });
    expect(parseCommand("hello")).toEqual({ kind: "none" });
  });

  it("finds an address in a raw argument or a market link", () => {
    expect(parseTarget(MARKET.toLowerCase())).toBe(MARKET);
    expect(parseTarget(`https://book.playhunch.xyz/m/${MARKET}`)).toBe(MARKET);
    expect(parseTarget("0x1234")).toBeNull();
  });

  it("watches a market or a wallet, lists, and unwatches", async () => {
    const store = new SubscriptionStore(null, 3);
    const deps = { store, isMarket: async (a: string) => a === MARKET, ...LINKS };
    expect(await handleCommand("7", "/start", deps)).toMatch(/\/watch/);
    expect(await handleCommand("7", `/watch https://book.playhunch.xyz/m/${MARKET}`, deps)).toMatch(
      /Watching market/,
    );
    expect(await handleCommand("7", `/watch ${WALLET}`, deps)).toMatch(/Watching wallet/);
    expect(await handleCommand("7", `/watch ${WALLET}`, deps)).toMatch(/already watching/);
    expect(await handleCommand("7", "/list", deps)).toMatch(/Market 0x2A44.*\n.*Wallet 0x5836/);
    expect(await handleCommand("7", "/watch nothing", deps)).toMatch(/not an address/);
    expect(await handleCommand("7", `/unwatch ${MARKET}`, deps)).toMatch(/Stopped watching/);
    expect(await handleCommand("7", `/unwatch ${MARKET}`, deps)).toMatch(/were not watching/);
    expect(await handleCommand("7", "/unwatch all", deps)).toBe("Stopped watching all 1.");
    expect(await handleCommand("7", "/list", deps)).toMatch(/not watching anything/);
    expect(await handleCommand("7", "just chatting", deps)).toBeNull();
  });

  it("caps the watches per chat", async () => {
    const store = new SubscriptionStore(null, 1);
    const deps = { store, isMarket: async () => false, ...LINKS };
    await handleCommand("7", `/watch ${WALLET}`, deps);
    expect(await handleCommand("7", `/watch ${MARKET}`, deps)).toMatch(/as many things/);
  });
});

describe("subscription store", () => {
  it("persists to a file and survives bad entries", () => {
    const file = join(mkdtempSync(join(tmpdir(), "notifier-subs-")), "subs.json");
    const store = new SubscriptionStore(file);
    store.add("7", "market", MARKET);
    store.add("8", "wallet", WALLET);
    store.add("9", "wallet", WALLET);
    const again = new SubscriptionStore(file);
    expect(again.list("7").markets).toEqual([MARKET]);
    expect(again.marketWatchers(MARKET)).toEqual(["7"]);
    expect(again.walletWatchers().get(WALLET)).toEqual(["8", "9"]);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    expect(
      parseSubscriptions(`{"chats":{"x":{"markets":["0x1"]},"5":{"markets":["nope","${MARKET}"]}}}`).chats,
    ).toEqual({
      "5": { markets: [MARKET], wallets: [] },
    });
    expect(parseSubscriptions("{").chats).toEqual({});
  });
});

describe("events", () => {
  const base = (m: MarketState): Map<string, Remembered> =>
    new Map([[m.address.toLowerCase(), { phase: m.phase, graduated: m.graduated, baseBps: m.chanceBps }]]);

  it("says nothing about a market seen for the first time", () => {
    expect(diffMarkets(new Map(), [market()], 1_000).events).toEqual([]);
  });

  it("reports graduation, settlement and void once", () => {
    const pool = market();
    const graduated = market({ phase: Phase.Graduated, graduated: true, chanceBps: 6_100 });
    const first = diffMarkets(base(pool), [graduated], 1_000);
    expect(first.events.map((e) => e.kind)).toEqual(["graduated"]);
    expect(diffMarkets(first.next, [graduated], 1_000).events).toEqual([]);
    const settled = market({ phase: Phase.Settled, graduated: true, outcome: Outcome.Yes });
    expect(diffMarkets(first.next, [settled], 1_000).events.map((e) => e.kind)).toEqual(["settled"]);
    const voided = market({ phase: Phase.Voided });
    expect(diffMarkets(base(pool), [voided], 1_000).events.map((e) => e.kind)).toEqual(["voided"]);
  });

  it("reports a big move on a book from the last move reported, not on pools", () => {
    const book = (bps: number) => market({ phase: Phase.Graduated, graduated: true, chanceBps: bps });
    let state = base(book(5_000));
    const steps = [5_500, 5_900, 6_100, 6_300];
    const kinds: number[][] = [];
    for (const bps of steps) {
      const r = diffMarkets(state, [book(bps)], 1_000);
      kinds.push(r.events.flatMap((e) => (e.kind === "move" ? [e.fromBps, e.toBps] : [])));
      state = r.next;
    }
    expect(kinds).toEqual([[], [], [5_000, 6_100], []]);
    expect(
      diffMarkets(base(market({ chanceBps: 1_000 })), [market({ chanceBps: 9_000 })], 1_000).events,
    ).toEqual([]);
  });

  it("knows what a wallet can collect from a final market", () => {
    const yes = market({ phase: Phase.Settled, outcome: Outcome.Yes, graduated: true });
    expect(redeemable(yes, position({ yes: 5_000_000n }))).toEqual({
      amount: 5_000_000n,
      kind: "tokens",
      side: "yes",
    });
    expect(redeemable(yes, position({ no: 5_000_000n }))).toBeNull();
    expect(redeemable(yes, position({ claimableYes: 2n }))).toEqual({
      amount: 2n,
      kind: "claim",
      side: "yes",
    });
    const poolWin = market({ phase: Phase.Settled, outcome: Outcome.No });
    expect(redeemable(poolWin, position({ claimablePool: 9n }))).toEqual({
      amount: 9n,
      kind: "pool",
      side: null,
    });
    const voided = market({ phase: Phase.Voided, graduated: true });
    expect(redeemable(voided, position({ yes: 1n, no: 2n }))?.amount).toBe(3n);
    expect(redeemable(market(), position({ yes: 1n }))).toBeNull();
  });
});

describe("messages", () => {
  it("reads in plain words with the app and explorer links", () => {
    const m = market({ phase: Phase.Graduated, graduated: true, chanceBps: 6_150 });
    const text = eventMessage({ kind: "graduated", market: m }, LINKS);
    expect(text).toMatch(/^Graduated: Will BTC longs pay shorts on net/);
    expect(text).toContain("690.00 USDC");
    expect(text).toContain("at 61.5% YES");
    expect(text).toContain(`https://book.playhunch.xyz/m/${MARKET}`);
    expect(text).toContain(`https://testnet.monadscan.com/address/${MARKET}`);
    expect(text).not.toMatch(/—/);
    expect(
      eventMessage({ kind: "settled", market: market({ phase: Phase.Settled, outcome: Outcome.No }) }, LINKS),
    ).toMatch(/^Settled NO/);
    expect(eventMessage({ kind: "voided", market: market({ phase: Phase.Voided }) }, LINKS)).toMatch(
      /refunded in full/,
    );
    expect(eventMessage({ kind: "move", market: m, fromBps: 5_000, toBps: 6_150 }, LINKS)).toMatch(
      /from 50.0% to 61.5% \(the book's mid price\)/,
    );
    const ready = redeemMessage(WALLET, m, { amount: 12_340_000n, kind: "tokens", side: "yes" }, LINKS);
    expect(ready).toMatch(/Ready to collect for 0x5836…95EB/);
    expect(ready).toContain("12.34 winning YES tokens");
    expect(chance(null)).toBe("n/a");
    expect(
      eventMessage(
        { kind: "settled", market: market({ question: null, phase: Phase.Settled, outcome: 1 }) },
        LINKS,
      ),
    ).toMatch(/Hunch Book market #1/);
  });
});

describe("where a graduated market trades", () => {
  it("names the market's venue: Hunch Book's own order book, Kuru's, or just its book", () => {
    const graduated = (over: Partial<MarketState>) =>
      eventMessage(
        { kind: "graduated", market: market({ phase: Phase.Graduated, graduated: true, ...over }) },
        LINKS,
      );
    expect(graduated({ venue: "hunch", kuruVersion: 1 })).toContain(
      "now trading on Hunch Book's own order book",
    );
    expect(graduated({ venue: "kuru", kuruVersion: 1 })).toContain("now trading on Kuru's order book");
    expect(graduated({ venue: "kuru", kuruVersion: 2 })).toContain("now trading on Kuru v2's order book");
    expect(graduated({})).toContain("now trading on its order book");
    expect(bookPhrase({ venue: "hunch" })).not.toMatch(/Kuru/);
  });

  // Testnet's layout: the primary stack on Kuru, and `hunch` on Hunch Book's own order book.
  const HUNCH_FACTORY = getAddress("0x00000000000000000000000000000000000000f5");
  const HUNCH_MARKET = getAddress("0x00000000000000000000000000000000000000b5");
  const withHunch: Deployment = {
    ...deployments["monad-testnet"],
    stacks: {
      hunch: {
        factory: HUNCH_FACTORY,
        kuruVersion: 1,
        venue: {
          kind: "hunch",
          bookFactory: getAddress("0x00000000000000000000000000000000000000f6"),
          marginAccount: getAddress("0x00000000000000000000000000000000000000f7"),
          bookImplementation: getAddress("0x00000000000000000000000000000000000000f8"),
        },
      },
    },
  };

  it("reads every stack's markets from the chain, each with its venue", async () => {
    const primaryFactory = deployments["monad-testnet"].hunchBook.factory as string;
    const counts: Record<string, bigint> = {
      [primaryFactory.toLowerCase()]: 1n,
      [HUNCH_FACTORY.toLowerCase()]: 1n,
    };
    const client = {
      readContract: async ({ address }: { address: string }) => counts[address.toLowerCase()] ?? 0n,
      multicall: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
        contracts.map((c) => {
          const hunch = c.address.toLowerCase() === HUNCH_FACTORY.toLowerCase() || c.address === HUNCH_MARKET;
          const result = (() => {
            switch (c.functionName) {
              case "marketAt":
                return hunch ? HUNCH_MARKET : MARKET;
              case "marketId":
                return 1n;
              case "phase":
                return Phase.Graduated;
              case "graduated":
                return true;
              case "poolTotals":
                return [410_000_000n, 280_000_000n, 11];
              case "tokens":
                return [
                  getAddress("0x00000000000000000000000000000000000000c1"),
                  getAddress("0x00000000000000000000000000000000000000c2"),
                ];
              case "outcome":
                return 0;
              default:
                return undefined;
            }
          })();
          return result === undefined
            ? { status: "failure", error: new Error("x") }
            : { status: "success", result };
        }),
    };
    const states = await readMarketsFromChain(client as never, withHunch);
    expect(states.map((m) => [m.address, m.venue, m.kuruVersion])).toEqual([
      [MARKET, "kuru", 1],
      [HUNCH_MARKET, "hunch", 1],
    ]);
  });

  it("takes the venue from the indexer's stack", async () => {
    const row = (id: string, stack: string) => ({
      id,
      number: 1,
      stack,
      stage: "Graduated",
      outcome: "Unresolved",
      graduated: true,
      impliedChanceBps: 5_000,
      lastPriceE6: "500000",
      question: null,
      poolTotal: "690000000",
      yesToken: "0x00000000000000000000000000000000000000c1",
      noToken: "0x00000000000000000000000000000000000000c2",
    });
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ data: { Market: [row(MARKET, "primary"), row(HUNCH_MARKET, "hunch")] } }),
      );
    const states = await readMarketsFromIndexer("https://indexer/v1/graphql", fetchImpl, withHunch);
    expect(states.map((m) => m.venue)).toEqual(["kuru", "hunch"]);
    // Without the deployment, or for a stack it does not list, the venue stays unknown.
    expect((await readMarketsFromIndexer("https://i", fetchImpl)).map((m) => m.venue)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("state", () => {
  it("round-trips through its file and survives garbage", () => {
    const file = join(mkdtempSync(join(tmpdir(), "notifier-state-")), "state.json");
    const s = emptyState();
    s.markets.set(MARKET.toLowerCase(), { phase: 2, graduated: true, baseBps: 6_000 });
    s.redeemed.add("a:b");
    s.telegramOffset = 42;
    saveState(file, s);
    const back = loadState(file);
    expect(back.markets.get(MARKET.toLowerCase())).toEqual({ phase: 2, graduated: true, baseBps: 6_000 });
    expect([...back.redeemed]).toEqual(["a:b"]);
    expect(back.telegramOffset).toBe(42);
    expect(parseState("nope").markets.size).toBe(0);
  });
});

describe("markets", () => {
  it("takes the book mid only when both sides have orders", () => {
    expect(midBps(600_000_000_000_000_000n, 700_000_000_000_000_000n)).toBe(6_500);
    expect(midBps(0n, 700_000_000_000_000_000n)).toBeNull();
    // Kuru v2 books answer pricePrecision units (1e6 on Hunch books); 0 or 2^32 - 1 is empty.
    expect(midBps(600_000n, 700_000n, 2)).toBe(6_500);
    expect(midBps(600_000n, 2n ** 32n - 1n, 2)).toBeNull();
    expect(midBps(2n ** 256n - 1n, 700_000_000_000_000_000n)).toBeNull();
  });

  it("reads markets from the indexer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              Market: [
                {
                  id: MARKET.toLowerCase(),
                  number: 1,
                  stage: "Graduated",
                  outcome: "Unresolved",
                  graduated: true,
                  impliedChanceBps: 5_942,
                  lastPriceE6: "615000",
                  question: "Q?",
                  poolTotal: "690000000",
                  yesToken: "0x00000000000000000000000000000000000000c1",
                  noToken: "0x00000000000000000000000000000000000000c2",
                },
              ],
            },
          }),
        ),
    );
    const [m] = await readMarketsFromIndexer("https://indexer/v1/graphql", fetchImpl);
    expect(m).toMatchObject({
      address: MARKET,
      phase: Phase.Graduated,
      chanceBps: 6_150,
      poolTotal: 690_000_000n,
    });
    await expect(
      readMarketsFromIndexer("https://i", async () => new Response(JSON.stringify({ errors: [1] }))),
    ).rejects.toThrow(/errors/);
  });
});

describe("notifier cycle", () => {
  let states: MarketState[];
  let positions: Position;

  // A fake chain: the primary factory lists the markets in `states` (any other stack's factory lists
  // none); wallets hold `positions` in each.
  const PRIMARY_FACTORY = deployments["monad-testnet"].hunchBook.factory?.toLowerCase();
  function fakeClient() {
    return {
      readContract: vi.fn(
        async ({
          address,
          functionName,
          args,
        }: {
          address?: string;
          functionName: string;
          args?: unknown[];
        }) => {
          const primary = address?.toLowerCase() === PRIMARY_FACTORY;
          if (functionName === "marketCount") return primary ? BigInt(states.length) : 0n;
          if (functionName === "isMarket") return primary && args?.[0] === MARKET;
          throw new Error(functionName);
        },
      ),
      multicall: vi.fn(
        async ({ contracts }: { contracts: { address: string; functionName: string; args?: unknown[] }[] }) =>
          contracts.map((c) => {
            const m = states.find((s) => s.address === c.address) ?? states[0];
            const result = (() => {
              switch (c.functionName) {
                case "marketAt":
                  return states[Number(c.args?.[0])]?.address;
                case "marketId":
                  return BigInt(m?.marketId ?? 0);
                case "phase":
                  return m?.phase;
                case "outcome":
                  return m?.outcome;
                case "graduated":
                  return m?.graduated;
                case "poolTotals":
                  return [410_000_000n, 280_000_000n, 11];
                case "tokens":
                  return [m?.yes, m?.no];
                case "book":
                  return "0x0000000000000000000000000000000000000000";
                case "resolver":
                  return "0x00000000000000000000000000000000000000e1";
                case "params":
                  return "0x01";
                case "describe":
                  return m?.question;
                case "stakeOf":
                  return [positions.stakeYes, positions.stakeNo];
                case "claimableTokens":
                  return [positions.claimableYes, positions.claimableNo];
                case "claimablePool":
                  return [positions.claimablePool, 0n];
                case "balanceOf":
                  return c.address === m?.yes ? positions.yes : positions.no;
                default:
                  return undefined;
              }
            })();
            return result === undefined
              ? { status: "failure", error: new Error("x") }
              : { status: "success", result };
          }),
      ),
    };
  }

  beforeEach(() => {
    states = [market()];
    positions = position({ stakeYes: 25_000_000n });
  });

  function make() {
    const messenger = new DryRunMessenger();
    const store = new SubscriptionStore(null);
    const config = { ...parseConfig({}), stateFile: "", healthFile: "", subscriptionsFile: "" };
    const notifier = new Notifier(
      { ...config, stateFile: null as never, healthFile: null as never },
      { client: fakeClient() as never, messenger, telegram: null, store, state: emptyState() },
    );
    return { notifier, messenger, store };
  }

  it("tells market watchers and holders' watchers once, and wallets when winnings are ready", async () => {
    const { notifier, messenger, store } = make();
    store.add("100", "market", MARKET);
    store.add("200", "wallet", WALLET);
    expect((await notifier.cycle()).events).toBe(0);
    expect(messenger.sent).toEqual([]);

    states = [market({ phase: Phase.Graduated, graduated: true })];
    const second = await notifier.cycle();
    expect(second.events).toBe(1);
    expect(messenger.sent.map((m) => m.chat).sort()).toEqual(["100", "200"]);
    expect(messenger.sent[0]?.text).toMatch(/^Graduated/);

    messenger.sent.length = 0;
    states = [market({ phase: Phase.Settled, graduated: true, outcome: Outcome.Yes })];
    positions = position({ yes: 36_000_000n });
    await notifier.cycle();
    const texts = messenger.sent.map((m) => `${m.chat}: ${m.text.split("\n")[0]}`);
    expect(texts).toContain(
      "100: Settled YES: Will BTC longs pay shorts on net between block 1 and block 2?",
    );
    expect(texts).toContain(
      "200: Settled YES: Will BTC longs pay shorts on net between block 1 and block 2?",
    );
    expect(texts.some((t) => t.startsWith("200: Ready to collect"))).toBe(true);

    messenger.sent.length = 0;
    await notifier.cycle();
    expect(messenger.sent).toEqual([]);
  });

  it("answers commands with the factory's word on what is a market", async () => {
    const { notifier, store } = make();
    expect(await notifier.reply("5", `/watch ${MARKET}`)).toMatch(/Watching market/);
    expect(await notifier.reply("5", `/watch ${OTHER}`)).toMatch(/Watching wallet/);
    expect(store.list("5")).toEqual({ markets: [MARKET], wallets: [OTHER] });
  });
});
