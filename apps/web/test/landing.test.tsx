import { deployments, Outcome, Phase } from "@hunch-book/shared";
import { render, screen } from "@testing-library/react";
import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../src/app/page";
import { blockTimeWords, Landing, lifecycleSteps, ruleWords } from "../src/components/landing/Landing";
import { isSeededByUs, type LandingRead, type LandingSnapshot, ourAddresses } from "../src/lib/chain/landing";
import { lifecycleStages } from "../src/lib/market/logic";
import { BOOK, deployed, marketAddr, marketHandlers, notDeployed, stubClient } from "./chain";
import { FACTORY, makeMarket, RESOLVER, USDC } from "./fixtures";

// The landing page with a fixed deployment (so tests do not move when deployments/*.json changes)
// and, for the page itself, a mocked chain read.

const GUARDIAN = "0x00000000000000000000000000000000000000d9" as Address;
const VAULT = "0x00000000000000000000000000000000000000aa" as Address;

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

const snapshot = (over: Partial<LandingSnapshot> = {}): LandingRead => ({
  status: "ok",
  data: { marketCount: 2, newest: seededMarket, rule: RULE, msPerBlock: 300, block: 67_862_094n, ...over },
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
        ...over,
      },
      { "2000000": 1_000_003_000n, "1990000": 1_000_000_000n },
    );

  it("is not-deployed without a factory, and makes no call", async () => {
    const client = stubClient({});
    expect(await readLandingSnapshot(client, notDeployed)).toEqual({ status: "not-deployed" });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("reads the count, the newest market, the rule and the block pace", async () => {
    const result = await readLandingSnapshot(withTemplate(), deployed);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.marketCount).toBe(2);
    expect(result.data.newest?.address).toBe(marketAddr(1));
    expect(result.data.newest?.book).toBe(BOOK);
    expect(result.data.rule).toEqual(RULE);
    expect(result.data.msPerBlock).toBe(300);
    expect(result.data.block).toBe(2_000_000n);
  });

  it("hides only the part that fails", async () => {
    const client = withTemplate({
      templateOf: () => {
        throw new Error("revert");
      },
    });
    client.getBlock = vi.fn().mockRejectedValue(new Error("rpc"));
    const result = await readLandingSnapshot(client, deployed);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.data.rule).toBeNull();
    expect(result.data.msPerBlock).toBeNull();
    expect(result.data.block).toBeNull();
    expect(result.data.newest?.address).toBe(marketAddr(1));
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

describe("our own wallets", () => {
  const d = {
    ...deployments["monad-testnet"],
    hunchBook: { factory: FACTORY, guardian: GUARDIAN, feeRecipient: GUARDIAN },
  };

  it("lists the guardian, fee recipient, maker and keeper", () => {
    expect(ourAddresses(d)).toEqual([GUARDIAN, GUARDIAN, d.wallets.maker, d.wallets.keeper]);
    expect(ourAddresses({ ...d, hunchBook: {} })).toEqual([d.wallets.maker, d.wallets.keeper]);
  });

  it("marks markets created by them as seeded, whatever the address case", () => {
    expect(isSeededByUs(d, GUARDIAN.toUpperCase().replace("0X", "0x") as Address)).toBe(true);
    expect(isSeededByUs(d, d.wallets.keeper)).toBe(true);
    expect(isSeededByUs(d, "0x1111111111111111111111111111111111111111")).toBe(false);
  });
});

describe("words and stages", () => {
  it("puts the chain's rule into a sentence", () => {
    expect(ruleWords(RULE)).toBe(
      "at least 500 USDC from at least 10 wallets, with a chance between 3% and 97%",
    );
    expect(blockTimeWords(301.4)).toBe("0.30 seconds");
  });

  it("only states the rule numbers it has read", () => {
    expect(lifecycleSteps(RULE)[1]?.facts).toEqual(["pool ≥ 500 USDC", "stakers ≥ 10", "chance 3% to 97%"]);
    expect(lifecycleSteps(null)[1]?.body).toMatch(/meets its graduation rule/);
    expect(lifecycleSteps(null)[1]?.body).not.toMatch(/\d/);
  });

  it("places a market on the Pool, Graduate, Trade, Settle track", () => {
    expect(lifecycleStages({ phase: Phase.Pool, graduated: false })).toEqual([
      "current",
      "todo",
      "todo",
      "todo",
    ]);
    expect(lifecycleStages({ phase: Phase.Graduated, graduated: true })).toEqual([
      "done",
      "done",
      "current",
      "todo",
    ]);
    expect(lifecycleStages({ phase: Phase.Closed, graduated: true })).toEqual([
      "done",
      "done",
      "done",
      "current",
    ]);
    expect(lifecycleStages({ phase: Phase.PoolLocked, graduated: false })).toEqual([
      "done",
      "skipped",
      "skipped",
      "current",
    ]);
    expect(lifecycleStages({ phase: Phase.Settled, graduated: false })).toEqual([
      "done",
      "skipped",
      "skipped",
      "done",
    ]);
    expect(lifecycleStages({ phase: Phase.Voided, graduated: true })).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });
});

// ---------- the page ----------

describe("landing page", () => {
  beforeEach(() => {
    mocked.read = snapshot();
  });

  it("leads with the noun and the two calls to action", () => {
    render(<Landing live={snapshot()} />);
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]?.textContent).toBe(
      "Prediction markets that start as pools and graduate to an onchain order book.",
    );
    expect(screen.getAllByRole("link", { name: "Open markets" })[0]?.getAttribute("href")).toBe("/markets");
    expect(screen.getAllByRole("link", { name: "Read the protocol" })[0]?.getAttribute("href")).toMatch(
      /docs\/PROTOCOL\.md$/,
    );
    expect(screen.getByText("Live on Monad testnet")).toBeTruthy();
    expect(screen.getByText(/Mainnet planned|Live on Monad mainnet/)).toBeTruthy();
  });

  it("has every section, in order, under one h1", () => {
    render(<Landing live={snapshot()} />);
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.id);
    expect(h2).toEqual([
      "how-title",
      "who-title",
      "live-title",
      "holds-title",
      "monad-title",
      "closing-title",
    ]);
  });

  it("shows the live figures read from the chain", () => {
    render(<Landing live={snapshot()} />);
    expect(
      screen.getByText(/at least 500 USDC from at least 10 wallets, with a chance between 3% and 97%/),
    ).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("markets created (factory.marketCount)")).toBeTruthy();
    expect(screen.getByText("0.30s")).toBeTruthy();
    expect(screen.getByText(/A block every 0\.30 seconds/)).toBeTruthy();
    expect(screen.getByText("Read at block 67,862,094")).toBeTruthy();
    expect(screen.getAllByText("40.0%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("690.00").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle(BOOK).length).toBeGreaterThan(0);
    expect(screen.getByText(/Trade \(now\)|\(now\)/)).toBeTruthy();
    expect(screen.getByText(/Testnet: stakes use Hunch Book's own test USDC/)).toBeTruthy();
  });

  it("labels a market our wallets created as seeded by Hunch Book", () => {
    render(<Landing live={snapshot()} />);
    expect(screen.getAllByText("Seeded by Hunch Book").length).toBe(2);
    expect(screen.getByText(/filled its pool from our own wallets to meet the graduation rule/)).toBeTruthy();
  });

  it("does not label someone else's market as ours", () => {
    const outside = makeMarket({ creator: "0x1111111111111111111111111111111111111111" });
    render(<Landing live={snapshot({ newest: outside })} />);
    expect(screen.queryByText("Seeded by Hunch Book")).toBeNull();
  });

  it("links the factory and vault from deployments", () => {
    render(<Landing live={snapshot()} />);
    const factory = screen.getAllByRole("link", { name: /^Factory/ })[0];
    expect(factory?.getAttribute("href")).toMatch(/0x00000000000000000000000000000000000000f1$/);
    const vault = screen.getAllByRole("link", { name: /^Vault/ })[0];
    expect(vault?.getAttribute("href")).toMatch(new RegExp(`${VAULT}$`));
  });

  it("hides every figure when the chain read fails, instead of guessing", () => {
    render(<Landing live={{ status: "error" }} />);
    expect(screen.getByText("Could not reach Monad testnet just now.")).toBeTruthy();
    expect(screen.getByText(/Live figures are unavailable right now/)).toBeTruthy();
    expect(screen.queryByText(/markets? created/)).toBeNull();
    expect(screen.queryByText(/Read at block/)).toBeNull();
    expect(screen.getByText(/meets its graduation rule/)).toBeTruthy();
    expect(screen.getByText(/Fast blocks and low fees/)).toBeTruthy();
    // The contract links still come from deployments.
    expect(screen.getAllByRole("link", { name: /^Factory/ }).length).toBeGreaterThan(0);
  });

  it("says so when there are no markets or no contracts yet", () => {
    const empty = render(<Landing live={snapshot({ marketCount: 0, newest: null })} />);
    expect(screen.getByText("No markets yet.")).toBeTruthy();
    empty.unmount();
    render(<Landing live={{ status: "not-deployed" }} />);
    expect(screen.getByText("The contracts are not deployed on Monad testnet yet.")).toBeTruthy();
  });

  it("shows a settled market's result on the track", () => {
    const settled = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes, graduated: true });
    render(<Landing live={snapshot({ newest: settled })} />);
    expect(screen.getAllByText("YES").length).toBeGreaterThan(0);
  });

  it("the page renders from the chain read, and from its fallback", async () => {
    const ok = render(await Home());
    expect(screen.getAllByText("Seeded by Hunch Book").length).toBe(2);
    ok.unmount();
    mocked.read = { status: "error" };
    render(await Home());
    expect(screen.getByText("Could not reach Monad testnet just now.")).toBeTruthy();
  });
});
