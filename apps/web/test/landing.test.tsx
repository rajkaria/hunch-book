import { deployments, Outcome, Phase } from "@hunch-book/shared";
import { render, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../src/app/page";
import {
  blockTimeWords,
  faqItems,
  Landing,
  lifecycleSteps,
  PROTOCOL,
  priceWords,
  ruleWords,
  StageTrack,
} from "../src/components/landing/Landing";
import { graduatedHint, vaultHint } from "../src/components/landing/LiveNumbers";
import {
  isSeededByUs,
  type LandingRead,
  type LandingSnapshot,
  type LandingStats,
  ourAddresses,
  pickFeatured,
  summarize,
} from "../src/lib/chain/landing";
import { BOOK, deployed, marketAddr, marketHandlers, notDeployed, stubClient } from "./chain";
import { FACTORY, makeMarket, RESOLVER, USDC } from "./fixtures";

// The landing page with a fixed deployment (so tests do not move when deployments/*.json changes)
// and, for the page itself, a mocked chain read.

const GUARDIAN = "0x00000000000000000000000000000000000000d9" as Address;
const VAULT = "0x00000000000000000000000000000000000000aa" as Address;
const FACTORY_F1 = "0x00000000000000000000000000000000000000f1";

const mocked = vi.hoisted(() => ({ read: undefined as unknown as LandingRead }));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  return {
    ...actual,
    appDeployment: {
      ...actual.appDeployment,
      hunchBook: {
        factory: "0x00000000000000000000000000000000000000f1",
        vault: "0x00000000000000000000000000000000000000aa",
        guardian: "0x00000000000000000000000000000000000000d9",
        graduator: "0x00000000000000000000000000000000000000c7",
        router: "0x00000000000000000000000000000000000000c8",
        resolvers: {
          perplFunding: "0x00000000000000000000000000000000000000e1",
          priceAtTime: "0x00000000000000000000000000000000000000e2",
        },
      },
    },
  };
});

vi.mock("@/lib/chain/landing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chain/landing")>();
  return { ...actual, readLandingSnapshot: vi.fn(async () => mocked.read) };
});

const RULE = { minPool: USDC(500), minStakers: 10, minChanceBps: 300, maxChanceBps: 9_700 };

const seededMarket = makeMarket({
  marketId: 1n,
  templateId: 1,
  phase: Phase.Graduated,
  graduated: true,
  creator: GUARDIAN,
  book: BOOK,
  quote: { bid: 380_000_000_000_000_000n, ask: 420_000_000_000_000_000n },
  pool: { yes: USDC(390), no: USDC(300), total: 0n, stakers: 11 },
  description: "Will MON longs pay more than $0.000015 per MON in funding on Perpl this week?",
});

const STATS: LandingStats = {
  listed: 2,
  graduated: 1,
  graduatedByUs: 1,
  createdByUs: 1,
  open: 2,
  settled: 0,
};

const snapshot = (over: Partial<LandingSnapshot> = {}): LandingRead => ({
  status: "ok",
  data: {
    marketCount: 2,
    newest: seededMarket,
    featured: seededMarket,
    stats: STATS,
    vault: { balance: USDC(710), obligations: USDC(700) },
    rule: RULE,
    msPerBlock: 300,
    block: 67_862_094n,
    blockTime: 1_791_090_000,
    ...over,
  },
});

// ---------- the read ----------

// The module is mocked for the page tests below; the read itself is tested on the real one.
const { readLandingSnapshot } =
  await vi.importActual<typeof import("../src/lib/chain/landing")>("../src/lib/chain/landing");

describe("readLandingSnapshot", () => {
  const withTemplate = (over = {}) =>
    stubClient(
      {
        ...marketHandlers(2),
        templateOf: () => ({ resolver: RESOLVER, rule: RULE }),
        balanceOf: () => USDC(710),
        totalObligations: () => USDC(700),
        ...over,
      },
      { "2000000": 1_000_003_000n, "1990000": 1_000_000_000n },
    );

  it("is not-deployed without a factory, and makes no call", async () => {
    const client = stubClient({});
    expect(await readLandingSnapshot(client, notDeployed)).toEqual({ status: "not-deployed" });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("reads the count, every listed market, the vault, the rule and the block pace", async () => {
    const result = await readLandingSnapshot(withTemplate(), deployed);
    if (result.status !== "ok") throw new Error("expected ok");
    const { data } = result;
    expect(data.marketCount).toBe(2);
    expect(data.newest?.address).toBe(marketAddr(1));
    // marketAddr(1) trades on its book; marketAddr(0) is still a pool.
    expect(data.featured?.address).toBe(marketAddr(1));
    expect(data.featured?.book).toBe(BOOK);
    expect(data.stats).toEqual({
      listed: 2,
      graduated: 1,
      graduatedByUs: 0,
      createdByUs: 0,
      open: 2,
      settled: 0,
    });
    expect(data.vault).toEqual({ balance: USDC(710), obligations: USDC(700) });
    expect(data.rule).toEqual(RULE);
    expect(data.msPerBlock).toBe(300);
    expect(data.block).toBe(2_000_000n);
    expect(data.blockTime).toBe(1_000_003_000);
  });

  it("reads the vault's balance and obligations in one multicall, so they share a block", async () => {
    const client = withTemplate();
    await readLandingSnapshot(client, deployed);
    const vaultCall = vi
      .mocked(client.multicall)
      .mock.calls.map(([args]) => args.contracts as readonly { functionName: string }[])
      .find((contracts) => contracts.some((c) => c.functionName === "totalObligations"));
    expect(vaultCall?.map((c) => c.functionName)).toEqual(["balanceOf", "totalObligations"]);
  });

  it("hides only the part that fails", async () => {
    const client = withTemplate({
      templateOf: () => {
        throw new Error("revert");
      },
      totalObligations: () => {
        throw new Error("revert");
      },
    });
    client.getBlock = vi.fn().mockRejectedValue(new Error("rpc"));
    const result = await readLandingSnapshot(client, deployed);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.rule).toBeNull();
    expect(result.data.vault).toBeNull();
    expect(result.data.msPerBlock).toBeNull();
    expect(result.data.block).toBeNull();
    expect(result.data.blockTime).toBeNull();
    expect(result.data.newest?.address).toBe(marketAddr(1));
    expect(result.data.stats?.listed).toBe(2);
  });

  it("keeps the count when the market list cannot be read", async () => {
    const client = withTemplate();
    client.multicall = vi.fn().mockRejectedValue(new Error("rpc")) as never;
    const result = await readLandingSnapshot(client, deployed);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.marketCount).toBe(2);
    expect(result.data.featured).toBeNull();
    expect(result.data.newest).toBeNull();
    expect(result.data.stats).toBeNull();
    expect(result.data.vault).toBeNull();
  });

  it("treats an empty rule as unknown, and an empty factory as no market", async () => {
    const result = await readLandingSnapshot(
      withTemplate({
        marketCount: () => 0n,
        templateOf: () => ({
          resolver: RESOLVER,
          rule: { minPool: 0n, minStakers: 0, minChanceBps: 0, maxChanceBps: 0 },
        }),
      }),
      deployed,
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.marketCount).toBe(0);
    expect(result.data.newest).toBeNull();
    expect(result.data.featured).toBeNull();
    expect(result.data.stats?.listed).toBe(0);
    expect(result.data.rule).toBeNull();
  });

  it("returns an error, never a guess, when the factory cannot be read", async () => {
    const failing = withTemplate({
      marketCount: () => {
        throw new Error("rpc down");
      },
    });
    expect(await readLandingSnapshot(failing, deployed)).toEqual({ status: "error" });
  });

  it("gives up on a slow chain", async () => {
    const slow = withTemplate();
    slow.readContract = vi.fn(() => new Promise(() => {})) as never;
    expect(await readLandingSnapshot(slow, deployed, 20)).toEqual({ status: "error" });
  });
});

describe("the most active market", () => {
  const pool = (id: bigint, total: number, over = {}) =>
    makeMarket({
      marketId: id,
      address: marketAddr(Number(id)),
      pool: { yes: USDC(total / 2), no: USDC(total / 2), total: 0n, stakers: 3 },
      ...over,
    });

  it("puts a live book ahead of any pool, whatever their size", () => {
    const book = pool(1n, 50, { phase: Phase.Graduated, graduated: true });
    expect(pickFeatured([pool(2n, 900), book, pool(3n, 400)])?.marketId).toBe(1n);
  });

  it("picks the bigger pool, and the newer one on a tie", () => {
    expect(pickFeatured([pool(1n, 100), pool(2n, 300), pool(3n, 200)])?.marketId).toBe(2n);
    expect(pickFeatured([pool(4n, 100), pool(9n, 100), pool(5n, 100)])?.marketId).toBe(9n);
  });

  it("ranks open markets before settling ones, and settled or voided ones last", () => {
    const settled = pool(1n, 5_000, { phase: Phase.Settled, outcome: Outcome.Yes });
    const voided = pool(2n, 5_000, { phase: Phase.Voided });
    const closed = pool(3n, 10, { phase: Phase.Closed, graduated: true });
    expect(pickFeatured([settled, voided, closed])?.marketId).toBe(3n);
    expect(pickFeatured([settled, voided])?.marketId).toBe(1n);
    expect(pickFeatured([])).toBeNull();
  });

  it("counts graduated, open and settled markets, with ours counted apart", () => {
    const d = {
      ...deployments["monad-testnet"],
      stacks: undefined,
      hunchBook: { factory: FACTORY, guardian: GUARDIAN },
    };
    const stats = summarize(d, [
      makeMarket({ phase: Phase.Graduated, graduated: true, creator: GUARDIAN }),
      makeMarket({ phase: Phase.Graduated, graduated: true }),
      makeMarket({ phase: Phase.Pool }),
      makeMarket({ phase: Phase.Settled, graduated: false, creator: d.wallets.keeper }),
    ]);
    expect(stats).toEqual({ listed: 4, graduated: 2, graduatedByUs: 1, createdByUs: 2, open: 3, settled: 1 });
  });
});

describe("our own wallets", () => {
  const d = {
    ...deployments["monad-testnet"],
    stacks: undefined,
    hunchBook: { factory: FACTORY, guardian: GUARDIAN, feeRecipient: GUARDIAN },
  };

  it("lists the guardian, fee recipient, maker and keeper once each, every stack's too", () => {
    expect(ourAddresses(d)).toEqual([GUARDIAN, d.wallets.maker, d.wallets.keeper]);
    expect(ourAddresses({ ...d, hunchBook: {} })).toEqual([d.wallets.maker, d.wallets.keeper]);
    const other = "0x2222222222222222222222222222222222222222" as Address;
    const twoStacks = {
      ...d,
      stacks: { kuruV2: { factory: other, guardian: other, feeRecipient: GUARDIAN } },
    };
    expect(ourAddresses(twoStacks)).toEqual([GUARDIAN, other, d.wallets.maker, d.wallets.keeper]);
  });

  it("marks markets created by them as seeded, whatever the address case", () => {
    expect(isSeededByUs(d, GUARDIAN.toUpperCase().replace("0X", "0x") as Address)).toBe(true);
    expect(isSeededByUs(d, d.wallets.keeper)).toBe(true);
    expect(isSeededByUs(d, "0x1111111111111111111111111111111111111111")).toBe(false);
  });
});

describe("words and stages", () => {
  it("puts chain values into words", () => {
    expect(ruleWords(RULE)).toBe(
      "at least 500 USDC from at least 10 wallets, with a chance between 3% and 97%",
    );
    expect(blockTimeWords(301.4)).toBe("0.30 seconds");
    expect(priceWords(385_000_000_000_000_000n)).toBe("0.385");
    expect(priceWords(1_000_000_000_000_000_000n)).toBe("1.000");
  });

  it("only states the rule numbers it has read", () => {
    const [, book] = lifecycleSteps(RULE);
    expect(book?.facts.slice(0, 3)).toEqual(["pool ≥ 500 USDC", "stakers ≥ 10", "chance 3% to 97%"]);
    const [, unknown] = lifecycleSteps(null);
    expect(unknown?.body).toMatch(/meets its graduation rule/);
    expect(unknown?.body).not.toMatch(/\d/);
  });

  it("says settlement is live only where resolvers are deployed, and how many have settled", () => {
    const withResolvers = {
      ...deployments["monad-testnet"],
      hunchBook: { resolvers: { perplFunding: RESOLVER, priceAtTime: RESOLVER } },
    };
    const live = lifecycleSteps(RULE, { ...STATS, settled: 0 }, withResolvers)[2];
    expect(live?.status).toBe("live");
    expect(live?.facts).toContain("no market has settled yet");
    expect(lifecycleSteps(RULE, { ...STATS, settled: 3 }, withResolvers)[2]?.facts).toContain(
      "3 settled so far",
    );
    expect(lifecycleSteps(RULE, null, { ...withResolvers, hunchBook: {} })[2]?.status).toBe("building");
  });

  it("calls a stage live only when the contracts behind it are deployed", () => {
    const none = { ...deployments["monad-testnet"], hunchBook: {} };
    expect(lifecycleSteps(RULE, null, none).map((x) => x.status)).toEqual([
      "building",
      "building",
      "building",
    ]);
    const pools = { ...none, hunchBook: { factory: FACTORY, vault: FACTORY } };
    expect(lifecycleSteps(RULE, null, pools).map((x) => x.status)).toEqual(["live", "building", "building"]);
    const books = { ...none, hunchBook: { ...pools.hunchBook, graduator: FACTORY, router: FACTORY } };
    expect(lifecycleSteps(RULE, null, books).map((x) => x.status)).toEqual(["live", "live", "building"]);
  });

  it("links each stage and each safety claim to its section of the protocol", () => {
    for (const stage of lifecycleSteps(RULE)) expect(stage.more.href).toMatch(/docs\/PROTOCOL\.md#\d/);
    expect(PROTOCOL.void).toMatch(/#56-void$/);
    expect(PROTOCOL.access).toMatch(/#73-access-control$/);
  });

  it("places a market on the Pool, Book, Settle track", () => {
    const states = (phase: Phase, graduated: boolean) => {
      const { container, unmount } = render(<StageTrack m={{ phase, graduated }} />);
      const text = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
      unmount();
      return text;
    };
    expect(states(Phase.Pool, false)).toEqual(["Pool (now)", "Book", "Settle"]);
    expect(states(Phase.Graduated, true)).toEqual(["Pool (done)", "Book (now)", "Settle"]);
    expect(states(Phase.Closed, true)).toEqual(["Pool (done)", "Book (done)", "Settle (now)"]);
    expect(states(Phase.PoolLocked, false)).toEqual(["Pool (done)", "Book (skipped)", "Settle (now)"]);
    expect(states(Phase.Settled, false)).toEqual(["Pool (done)", "Book (skipped)", "Settle (done)"]);
  });

  it("explains the strip's figures, and labels our own stakes", () => {
    const data = (snapshot() as Extract<LandingRead, { status: "ok" }>).data;
    expect(vaultHint(data)).toBe("test USDC, including stakes from our own wallets");
    expect(vaultHint({ ...data, stats: { ...STATS, createdByUs: 0 } })).toBe("test USDC");
    expect(vaultHint({ ...data, vault: null })).toBe("could not read the vault just now");
    expect(graduatedHint(data)).toBe("1 was seeded by us");
    expect(graduatedHint({ ...data, stats: { ...STATS, graduatedByUs: 2, graduated: 3 } })).toBe(
      "2 were seeded by us",
    );
    expect(graduatedHint({ marketCount: 250, stats: { ...STATS, listed: 100, graduatedByUs: 0 } })).toBe(
      "each with its own order book, of the newest 100",
    );
    expect(graduatedHint({ ...data, stats: null })).toBe("could not read the markets just now");
  });
});

// ---------- the page ----------

describe("landing page", () => {
  beforeEach(() => {
    mocked.read = snapshot();
  });

  it("leads with the three stages and the two calls to action", () => {
    render(<Landing live={snapshot()} />);
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]?.textContent).toBe("Start as a pool. Graduate to a book. Settle from the chain.");
    expect(screen.getByText("Prediction markets on Monad")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Browse markets" })[0]?.getAttribute("href")).toBe("/markets");
    expect(screen.getAllByRole("link", { name: "Start a market" })[0]?.getAttribute("href")).toBe("/create");
    expect(screen.getAllByText("Live on Monad testnet").length).toBeGreaterThan(0);
    expect(screen.getByText(/Mainnet planned|Live on Monad mainnet/)).toBeTruthy();
  });

  it("has every section, in order, under one h1", () => {
    render(<Landing live={snapshot()} />);
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.id);
    expect(h2).toEqual([
      "live-title",
      "how-title",
      "who-title",
      "safety-title",
      "monad-title",
      "faq-title",
      "closing-title",
    ]);
  });

  it("shows the most active market live in the hero, with its book", () => {
    render(<Landing live={snapshot()} />);
    const card = screen.getByRole("complementary", { name: "Most active market, live" });
    const inCard = within(card);
    expect(inCard.getByRole("link", { name: seededMarket.description ?? "" }).getAttribute("href")).toBe(
      `/m/${seededMarket.address}`,
    );
    expect(inCard.getAllByText("40.0%").length).toBeGreaterThan(0);
    expect(inCard.getByText("Mid price on Kuru")).toBeTruthy();
    expect(inCard.getByText("0.380")).toBeTruthy();
    expect(inCard.getByText("0.420")).toBeTruthy();
    expect(inCard.getByText("690.00")).toBeTruthy();
    expect(inCard.getByText("Live book")).toBeTruthy();
    expect(inCard.getByRole("list", { name: "Where this market is" }).textContent).toContain("Book (now)");
    expect(inCard.getByTitle(BOOK)).toBeTruthy();
    expect(inCard.getByRole("img", { name: "YES 40.0%" })).toBeTruthy();
  });

  it("shows a pool's two sides and its graduation target", () => {
    const pool = makeMarket({ marketId: 3n });
    render(<Landing live={snapshot({ featured: pool })} />);
    const card = within(screen.getByRole("complementary", { name: "Most active market, live" }));
    expect(card.getByText("YES pool")).toBeTruthy();
    expect(card.getByText("300.00")).toBeTruthy();
    expect(card.getByText("100.00")).toBeTruthy();
    expect(card.getByText("500 USDC")).toBeTruthy();
    expect(card.getAllByText("75.0%").length).toBeGreaterThan(0);
    expect(card.getByText("Pool split")).toBeTruthy();
    expect(card.getByText("No Kuru book yet")).toBeTruthy();
  });

  it("shows live numbers read from the chain, each linked to its source", () => {
    render(<Landing live={snapshot()} />);
    const strip = within(screen.getByRole("region", { name: "Live from Monad testnet" }));
    expect(strip.getByText("Markets created")).toBeTruthy();
    expect(strip.getByText("2")).toBeTruthy();
    expect(strip.getByText("2 open now")).toBeTruthy();
    expect(strip.getByRole("link", { name: /factory\.marketCount/ }).getAttribute("href")).toMatch(
      new RegExp(`${FACTORY_F1}$`),
    );
    expect(strip.getByText("710.00")).toBeTruthy();
    expect(strip.getByText("test USDC, including stakes from our own wallets")).toBeTruthy();
    expect(strip.getByRole("link", { name: /USDC\.balanceOf\(vault\)/ }).getAttribute("href")).toMatch(
      new RegExp(`${VAULT}$`),
    );
    expect(strip.getByText("1 was seeded by us")).toBeTruthy();
    expect(strip.getByRole("link", { name: /see the books/ }).getAttribute("href")).toBe(
      "/markets?phase=trading",
    );
    expect(strip.getByText("Planned")).toBeTruthy();
    expect(strip.getByRole("link", { name: /how we will count/ }).getAttribute("href")).toBe("/proof");
    expect(strip.getByText("0.30s")).toBeTruthy();
    expect(strip.getByRole("link", { name: /block 67,862,094/ }).getAttribute("href")).toMatch(/67862094$/);
    expect(strip.getByText("Read at block 67,862,094. Refreshes about every 30 seconds.")).toBeTruthy();
    expect(strip.getByText(/Testnet: stakes use Hunch Book's own test USDC/)).toBeTruthy();
  });

  it("explains the lifecycle with the rule read from the chain", () => {
    render(<Landing live={snapshot()} />);
    // Two drawings of the same lifecycle (wide and tall); CSS shows one of them.
    expect(
      screen.getAllByRole("img", { name: /Lifecycle: a pool graduates into a Kuru order book/ }),
    ).toHaveLength(2);
    expect(
      screen.getByText(/at least 500 USDC from at least 10 wallets, with a chance between 3% and 97%/),
    ).toBeTruthy();
    expect(screen.getAllByText("500 USDC, 10 wallets").length).toBeGreaterThan(0);
    // Hero badge, hero card, and the three stages.
    expect(screen.getAllByText("Live on Monad testnet")).toHaveLength(5);
    expect(screen.getByText("no market has settled yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Perpl funding" }).getAttribute("href")).toMatch(/0+e1$/);
  });

  it("says who can do what, with the vault's books read just now", () => {
    render(<Landing live={snapshot()} />);
    const safety = within(screen.getByRole("region", { name: "Your money does not depend on trusting us" }));
    expect(safety.getByRole("heading", { name: "Anyone" })).toBeTruthy();
    expect(safety.getByRole("heading", { name: /The guardian/ })).toBeTruthy();
    expect(safety.getByTitle(GUARDIAN)).toBeTruthy();
    expect(safety.getByText("pause settlement, redemption, merges or refunds")).toBeTruthy();
    expect(safety.getByRole("heading", { name: "Nobody" })).toBeTruthy();
    expect(safety.getByText("sets an outcome by hand.")).toBeTruthy();
    expect(safety.getByText("710.00")).toBeTruthy();
    expect(safety.getByText("700.00")).toBeTruthy();
    expect(safety.getByRole("link", { name: /Void terms/ }).getAttribute("href")).toMatch(/#56-void$/);
  });

  it("answers the common questions in disclosures", () => {
    const { container } = render(<Landing live={snapshot()} />);
    const items = container.querySelectorAll("details");
    expect(items).toHaveLength(faqItems().length);
    expect(Array.from(items).map((d) => d.querySelector("summary")?.textContent)).toEqual([
      "What are the fees?",
      "What happens if the data source fails?",
      "Can I sell before the answer?",
      "Who is on the other side of my trade?",
      "Who decides the outcome?",
      "What is live today?",
    ]);
    expect(Array.from(items).every((d) => !d.open)).toBe(true);
    expect(screen.getByText(/at most 1.94 cents/)).toBeTruthy();
    expect(screen.getByText(/redeems for 0.50 USDC, so someone who bought YES at 0.80/)).toBeTruthy();
    expect(screen.getByText(/Mainnet with real USDC is planned/)).toBeTruthy();
  });

  it("labels a market our wallets created as seeded by Hunch Book", () => {
    render(<Landing live={snapshot()} />);
    expect(screen.getAllByText("Seeded by Hunch Book")).toHaveLength(1);
    expect(screen.getByText(/filled its pool from our own wallets to meet the graduation rule/)).toBeTruthy();
  });

  it("does not label someone else's market as ours", () => {
    const outside = makeMarket({ creator: "0x1111111111111111111111111111111111111111" });
    render(
      <Landing
        live={snapshot({ featured: outside, stats: { ...STATS, createdByUs: 0, graduatedByUs: 0 } })}
      />,
    );
    expect(screen.queryByText("Seeded by Hunch Book")).toBeNull();
    expect(screen.queryByText(/our own wallets/)).toBeNull();
  });

  it("links the factory and vault from deployments", () => {
    render(<Landing live={snapshot()} />);
    const factory = screen.getAllByRole("link", { name: /^Factory/ })[0];
    expect(factory?.getAttribute("href")).toMatch(new RegExp(`${FACTORY_F1}$`));
    const vault = screen.getAllByRole("link", { name: /^Vault/ })[0];
    expect(vault?.getAttribute("href")).toMatch(new RegExp(`${VAULT}$`));
  });

  it("hides every figure when the chain read fails, instead of guessing", () => {
    render(<Landing live={{ status: "error" }} />);
    expect(screen.getByText("Could not reach Monad testnet just now.")).toBeTruthy();
    expect(screen.getByText(/Live figures are unavailable right now/)).toBeTruthy();
    expect(screen.queryByText(/Markets? created/)).toBeNull();
    expect(screen.queryByText(/Read at block/)).toBeNull();
    expect(screen.queryByText(/Holds/)).toBeNull();
    expect(screen.getByText(/meets its graduation rule/)).toBeTruthy();
    expect(screen.getByText(/Fast blocks and low fees/)).toBeTruthy();
    // The contract links still come from deployments.
    expect(screen.getAllByRole("link", { name: /^Factory/ }).length).toBeGreaterThan(0);
  });

  it("says so when there are no markets, the list failed, or nothing is deployed", () => {
    const empty = render(
      <Landing
        live={snapshot({ marketCount: 0, newest: null, featured: null, stats: { ...STATS, listed: 0 } })}
      />,
    );
    expect(
      screen.getByText("No markets yet. The first one appears here as soon as it is created."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start the first market" }).getAttribute("href")).toBe("/create");
    empty.unmount();

    const failedList = render(<Landing live={snapshot({ featured: null, newest: null, stats: null })} />);
    expect(screen.getByText(/Could not read the markets just now/)).toBeTruthy();
    expect(screen.getAllByText("could not read the markets just now").length).toBeGreaterThan(0);
    failedList.unmount();

    render(<Landing live={{ status: "not-deployed" }} />);
    expect(screen.getByText("The contracts are not deployed on Monad testnet yet.")).toBeTruthy();
  });

  it("shows a settled market's result", () => {
    const settled = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes, graduated: true });
    render(<Landing live={snapshot({ featured: settled })} />);
    const card = within(screen.getByRole("complementary", { name: "Most active market, live" }));
    expect(card.getAllByText("YES").length).toBeGreaterThan(0);
    expect(card.getByText("Settled YES")).toBeTruthy();
    expect(card.getByRole("list", { name: "Where this market is" }).textContent).toContain("Settle (done)");
  });

  it("opens every outside link in a new tab without a referrer, and uses no em dashes", () => {
    const { container } = render(<Landing live={snapshot()} />);
    const external = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[target=_blank]"));
    expect(external.length).toBeGreaterThan(10);
    for (const a of external) expect(a.getAttribute("rel")).toBe("noreferrer");
    // No em dashes in copy (CLAUDE.md, Rule 5).
    expect(container.textContent).not.toContain("\u2014");
  });

  it("the page renders from the chain read, and from its fallback", async () => {
    const ok = render(await Home());
    expect(screen.getAllByText("Seeded by Hunch Book")).toHaveLength(1);
    ok.unmount();
    mocked.read = { status: "error" };
    render(await Home());
    expect(screen.getByText("Could not reach Monad testnet just now.")).toBeTruthy();
  });
});
