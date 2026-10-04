import { deployments, Outcome, Phase, Side } from "@hunch-book/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsPanel } from "../src/components/market/ActionsPanel";
import { BookPanel } from "../src/components/market/BookPanel";
import { TradeTicket } from "../src/components/market/TradeTicket";
import { PortfolioRows } from "../src/components/portfolio/PortfolioView";
import { VerifyBody } from "../src/components/verify/VerifyView";
import { ConnectButton } from "../src/components/wallet/ConnectButton";
import { FAUCET_AMOUNT } from "../src/components/wallet/Faucet";
import { makeBalances, makeBook, makeEntry, makeMarket, USDC, USER } from "./fixtures";
import { renderWithProviders } from "./render";

// The trading and lifecycle UI against mocked reads and a mocked transaction runner: what each panel
// shows, what it disables and why, and the exact contract call each button sends.

/** The connected mock wallet, as wagmi reports it (checksummed). */
const ME = getAddress(USER);
const ROUTER = "0x00000000000000000000000000000000000000ee";
const VAULT = "0x00000000000000000000000000000000000000aa";
const USDC_TOKEN = "0x00000000000000000000000000000000000000ab";

type Q = { data?: unknown; isPending?: boolean; isError?: boolean };
const state = vi.hoisted(() => ({
  book: {} as Q,
  balances: {} as Q,
  position: {} as Q,
  plan: {} as Q,
  verification: {} as Q,
  settlementTx: {} as Q,
  faucet: {} as Q,
  refetch: vi.fn(),
  run: vi.fn(async () => true),
  runAll: vi.fn(async (steps: unknown[]) => steps.length),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  const deployment = {
    ...actual.appDeployment,
    hunchBook: { ...actual.appDeployment.hunchBook, router: "0x00000000000000000000000000000000000000ee" },
  };
  return { ...actual, appDeployment: deployment };
});

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  const q = (s: Q) => ({
    data: s.data,
    isPending: s.isPending ?? s.data === undefined,
    isError: s.isError ?? false,
    isFetching: false,
    refetch: state.refetch,
  });
  return {
    ...actual,
    useBook: () => q(state.book),
    useWalletBalances: () => q(state.balances),
    useUserPosition: () => q(state.position),
    useSettlePlan: () => q(state.plan),
    useVerification: () => q(state.verification),
    useSettlementTx: () => q(state.settlementTx),
    useTestUsdcFaucet: () => q(state.faucet),
    useProtocolAddresses: () =>
      q({
        data: {
          vault: "0x00000000000000000000000000000000000000aa",
          usdc: "0x00000000000000000000000000000000000000ab",
        },
      }),
    useNow: () => 1_799_000_000,
  };
});

// The ticket reads the latest block's time for the deadline; here the chain is a minute behind the browser.
vi.mock("@/lib/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chain/client")>();
  return {
    ...actual,
    getPublicClient: () => ({
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 60) }),
    }),
  };
});

vi.mock("@/lib/wallet/useTxRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/wallet/useTxRunner")>();
  return {
    ...actual,
    useTxRunner: () => ({
      run: state.run,
      runAll: state.runAll,
      txs: [],
      error: null,
      stage: "idle",
      progress: null,
      busy: false,
    }),
  };
});

const trading = makeMarket({
  phase: Phase.Graduated,
  graduated: true,
  book: "0x00000000000000000000000000000000000000bb",
  pool: { yes: USDC(410), no: USDC(280), total: USDC(690), stakers: 11 },
  quote: { bid: 350_000_000_000_000_000n, ask: 400_000_000_000_000_000n },
});

beforeEach(() => {
  state.book = { data: makeBook() };
  state.balances = { data: makeBalances() };
  state.position = {
    data: {
      stake: { yes: 0n, no: 0n },
      claimableTokens: { yes: 0n, no: 0n },
      claimablePool: { paid: 0n, fee: 0n },
    },
  };
  state.plan = {};
  state.verification = {};
  state.settlementTx = {};
  state.faucet = {};
  state.run.mockClear();
  state.runAll.mockClear();
  state.refetch.mockClear();
});

describe("TradeTicket", () => {
  it("waits for a wallet, but already quotes the touch and offers Max", async () => {
    await renderWithProviders(<TradeTicket m={trading} />);
    expect((screen.getByRole("button", { name: "Buy YES" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Connect a browser wallet to trade.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "YES side" }).textContent).toContain("from 0.400");
    expect(screen.getByRole("button", { name: "NO side" }).textContent).toContain("from 0.650");
  });

  it("quotes a buy, asks for an exact approval, then sends buyYes with the limit and a deadline", async () => {
    await renderWithProviders(<TradeTicket m={trading} />, { connected: true });
    fireEvent.change(screen.getByLabelText(/Spend/), { target: { value: "20" } });
    expect(screen.getByText("You get")).toBeTruthy();
    expect(screen.getByText("50.00 YES")).toBeTruthy();
    expect(screen.getByText("Minimum received (1%)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Step 1 of 2: approve 20.00 USDC" }));
    expect(state.run).toHaveBeenCalledWith(
      "Approve 20.00 USDC for the Hunch router",
      expect.objectContaining({ address: USDC_TOKEN, functionName: "approve", args: [ROUTER, USDC(20)] }),
      ME,
    );

    state.balances = {
      data: makeBalances({
        allowance: { usdcToRouter: USDC(20), usdcToVault: 0n, yesToRouter: 0n, noToRouter: 0n },
      }),
    };
    fireEvent.change(screen.getByLabelText(/Spend/), { target: { value: "20.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Buy YES" }));
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(2));
    const call = state.run.mock.calls.at(-1) as unknown as [string, { functionName: string; args: bigint[] }];
    expect(call[1].functionName).toBe("buyYes");
    const [market, amount, limit, deadline] = call[1].args;
    expect(market).toBe(trading.address);
    expect(amount).toBe(USDC(20));
    expect(limit).toBe(USDC(49.5));
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(deadline).toBeGreaterThan(now + 290n);
    expect(deadline).toBeLessThanOrEqual(now + 300n);
  });

  it("sells NO with its own unit, Max from the wallet and the book, and a NO approval", async () => {
    await renderWithProviders(<TradeTicket m={trading} />, { connected: true });
    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    fireEvent.click(screen.getByRole("button", { name: "NO side" }));
    expect(screen.getByText("You hold 80.00 NO")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect((screen.getByLabelText(/Sell/) as HTMLInputElement).value).toBe("80.00");
    expect(screen.getByRole("button", { name: "Step 1 of 2: approve 80.00 NO" })).toBeTruthy();
  });

  it("uses a custom slippage and rejects one out of range", async () => {
    await renderWithProviders(<TradeTicket m={trading} />, { connected: true });
    fireEvent.change(screen.getByLabelText(/Spend/), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Custom slippage in percent"), { target: { value: "2.5" } });
    expect(screen.getByText("Minimum received (2.5%)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Custom slippage in percent"), { target: { value: "80" } });
    expect(screen.getByText("Enter a slippage from 0.01% to 50%.")).toBeTruthy();
  });

  it("disables the trade with the reason when the book side is empty or the market closed", async () => {
    state.book = { data: makeBook({ asks: [] }) };
    const first = await renderWithProviders(<TradeTicket m={trading} />, { connected: true });
    expect(screen.getByText(/Nobody is selling YES/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Buy YES" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();
    await renderWithProviders(<TradeTicket m={{ ...trading, phase: Phase.Closed }} />, { connected: true });
    expect(screen.getByText(/stopped at close/)).toBeTruthy();
  });

  it("offers the test USDC faucet when the wallet is low", async () => {
    state.faucet = { data: { usdc: USDC_TOKEN, limit: USDC(10_000) } };
    state.balances = { data: makeBalances({ usdc: USDC(2) }) };
    await renderWithProviders(<TradeTicket m={trading} />, { connected: true });
    expect(screen.getByText("Low on USDC: your wallet holds 2.00.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get 1,000 test USDC" }));
    expect(state.run).toHaveBeenCalledWith(
      "Get 1,000.00 test USDC",
      expect.objectContaining({ address: USDC_TOKEN, functionName: "mint", args: [ME, FAUCET_AMOUNT] }),
      ME,
    );
    expect(screen.getByRole("link", { name: "Get testnet MON for gas" }).getAttribute("href")).toBe(
      "https://faucet.monad.xyz",
    );
  });
});

describe("BookPanel", () => {
  it("shows the ladder, the mid as the chance, and labels our maker's orders", async () => {
    state.book = { data: makeBook({ owned: { bids: [USDC(100), 0n], asks: [USDC(40), 0n] } }) };
    await renderWithProviders(<BookPanel m={trading} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    // header, 2 asks (worst first), spread, 2 bids
    expect(rows).toHaveLength(6);
    expect(rows[1]?.textContent).toContain("0.450");
    expect(rows[2]?.textContent).toContain("0.400");
    expect(rows[2]?.textContent).toContain("ours 40.00");
    expect(rows[3]?.textContent).toMatch(/Mid 0\.375 = 37\.5% chance of YES · spread 0\.050/);
    expect(rows[4]?.textContent).toContain("ours");
    expect(rows[5]?.textContent).toContain("400.00");
    expect(screen.getByText(/Hunch maker \(ours\):/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Kuru book on the explorer" }).getAttribute("href")).toContain(
      "0x00000000000000000000000000000000000000bb",
    );
  });

  it("says so when a side is empty", async () => {
    state.book = { data: makeBook({ bids: [] }) };
    await renderWithProviders(<BookPanel m={trading} />);
    expect(screen.getByText("No bids: nobody is buying YES.")).toBeTruthy();
    expect(screen.getByText("No two-sided quote, so no mid price yet.")).toBeTruthy();
  });
});

describe("ActionsPanel", () => {
  const head = { block: 99_000_000n, time: 1_800_100_000 };

  it("settles with the planned evidence once the resolver answers", async () => {
    state.plan = {
      data: {
        status: "ready",
        evidence: "0x",
        outcome: Outcome.No,
        evidenceHash: `0x${"00".repeat(32)}`,
        bracket: null,
      },
    };
    await renderWithProviders(<ActionsPanel m={{ ...trading, phase: Phase.Closed }} head={head} />, {
      connected: true,
    });
    expect(screen.getByText(/The resolver answers NO with this evidence/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    expect(state.runAll).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          request: expect.objectContaining({
            address: trading.address,
            functionName: "settle",
            args: ["0x"],
          }),
        }),
      ],
      ME,
    );
  });

  it("shows 'not resolvable yet' and keeps settle disabled", async () => {
    state.plan = {
      data: { status: "unresolved", reason: "Not resolvable yet: the source has no final answer." },
    };
    await renderWithProviders(<ActionsPanel m={{ ...trading, phase: Phase.Closed }} head={head} />, {
      connected: true,
    });
    expect(screen.getByText("Not resolvable yet: the source has no final answer.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Settle" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("redeems the winning side through the vault after settlement", async () => {
    state.balances = { data: makeBalances({ yes: USDC(100), no: USDC(40) }) };
    const settled = { ...trading, phase: Phase.Settled, outcome: Outcome.Yes };
    await renderWithProviders(<ActionsPanel m={settled} head={head} />, { connected: true });
    fireEvent.click(screen.getByRole("button", { name: "Redeem tokens" }));
    const [steps] = state.runAll.mock.calls.at(-1) as unknown as [
      { request: { address: string; functionName: string; args: unknown[] } }[],
    ];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.request).toMatchObject({
      address: VAULT,
      functionName: "redeem",
      args: [trading.address, Side.Yes, USDC(100), ME],
    });
    expect(screen.getByRole("link", { name: "verify page" }).getAttribute("href")).toBe(
      `/verify/${trading.address}`,
    );
  });

  it("claims tokens after graduation and keeps void for after the deadline", async () => {
    state.position = {
      data: {
        stake: { yes: USDC(10), no: 0n },
        claimableTokens: { yes: USDC(16.8), no: 0n },
        claimablePool: { paid: 0n, fee: 0n },
      },
    };
    await renderWithProviders(<ActionsPanel m={trading} head={{ block: 1n, time: 1_799_000_000 }} />, {
      connected: true,
    });
    expect((screen.getByRole("button", { name: "Void" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Claim tokens" }));
    expect(state.runAll).toHaveBeenCalledWith(
      [expect.objectContaining({ request: expect.objectContaining({ functionName: "claimTokens" }) })],
      ME,
    );
  });

  it("mints sets with an exact vault approval first, inside the collapsed advanced section", async () => {
    await renderWithProviders(<ActionsPanel m={trading} head={head} />, { connected: true });
    expect(screen.getByText("Mint and merge complete sets (advanced)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Mint sets/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Mint" }));
    const [steps] = state.runAll.mock.calls.at(-1) as unknown as [
      { request: { functionName: string; args: unknown[] } }[],
    ];
    expect(steps.map((s) => s.request.functionName)).toEqual(["approve", "mintSets"]);
    expect(steps[0]?.request.args).toEqual([VAULT, USDC(5)]);
    expect(steps[1]?.request.args).toEqual([trading.address, USDC(5), ME]);
  });
});

describe("Portfolio actions", () => {
  it("claims and redeems everything one by one", async () => {
    const settled = { ...trading, phase: Phase.Settled, outcome: Outcome.Yes };
    const pool = makeMarket({
      address: "0x00000000000000000000000000000000000000a9",
      phase: Phase.Settled,
      outcome: Outcome.Yes,
    });
    await renderWithProviders(
      <PortfolioRows
        entries={[
          makeEntry({
            market: settled,
            balances: { yes: USDC(10), no: 0n },
            claimableTokens: { yes: USDC(5), no: 0n },
          }),
          makeEntry({ market: pool, claimablePool: { paid: USDC(40), fee: USDC(0.5) } }),
        ]}
      />,
      { connected: true },
    );
    expect(screen.getByText(/3 transactions, sent one by one/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Claim and redeem all" }));
    const [steps] = state.runAll.mock.calls.at(-1) as unknown as [
      { request: { functionName: string; args?: unknown[] } }[],
    ];
    expect(steps.map((s) => s.request.functionName)).toEqual(["claimTokens", "redeem", "claimPool"]);
    expect(steps[1]?.request.args).toEqual([settled.address, Side.Yes, USDC(15), ME]);
    fireEvent.click(screen.getByRole("button", { name: "Claim pool payout" }));
    expect((state.runAll.mock.calls.at(-1) as unknown as [unknown[]])[0]).toHaveLength(1);
  });
});

describe("Verifier", () => {
  it("shows the stored settlement, the read and match badges, and re-runs on request", async () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    const m = makeMarket({ phase: Phase.Settled, outcome: Outcome.Yes, evidenceHash: hash, graduated: true });
    state.settlementTx = {
      data: {
        block: 1_234_567n,
        time: 1_800_100_000,
        hash: `0x${"77".repeat(32)}`,
        by: "0x00000000000000000000000000000000000000D9",
        kind: "settled",
        evidence: null,
      },
    };
    state.verification = {
      data: {
        mode: "settled",
        read: {
          template: "chainlink",
          feed: "0x12C0F44368a02081ce58a936d1C1F606BB301715",
          target: 1_800_086_400n,
          strikeE8: 12_000_000_000_000n,
          bracket: {
            status: "found",
            round: {
              roundId: 18_446_744_073_709_551_621n,
              answer: 12_100_000_000_000n,
              updatedAt: 1_800_086_000n,
            },
            next: { roundId: 18_446_744_073_709_551_622n, answer: 1n, updatedAt: 1_800_086_600n },
            staleSeconds: 400n,
          },
          bracketError: null,
          decimals: 8,
          priceE8: 12_100_000_000_000n,
          outcome: Outcome.Yes,
          expectedHash: hash,
        },
        rerun: { outcome: Outcome.Yes, evidenceHash: hash },
        rerunError: null,
        matches: { outcome: true, hash: true, resolver: true },
        rpc: deployments["monad-testnet"].rpc,
        ranAt: 1_800_200_000_000,
        headBlock: 9_999_999n,
      },
    };
    await renderWithProviders(<VerifyBody m={m} />);
    expect(screen.getByRole("heading", { name: "What the market stored" })).toBeTruthy();
    expect(screen.getByText("getRoundData(18446744073709551621)")).toBeTruthy();
    expect(screen.getByText(/\$121,000\.00/)).toBeTruthy();
    expect(screen.getAllByText("Match")).toHaveLength(3);
    expect(screen.getByText(/1,234,567/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-run this read from your browser" }));
    expect(state.refetch).toHaveBeenCalled();
  });

  it("previews an unsettled market without comparing", async () => {
    state.verification = {
      data: {
        mode: "preview",
        read: { template: "pyth" },
        rerun: null,
        rerunError: null,
        matches: null,
        rpc: "x",
        ranAt: 0,
        headBlock: 1n,
      },
    };
    await renderWithProviders(<VerifyBody m={makeMarket()} />);
    expect(screen.getByText("Not settled yet")).toBeTruthy();
    expect(screen.getByText(/Preview: this market has not settled/)).toBeTruthy();
    expect(screen.queryByText("Match")).toBeNull();
  });
});

describe("Wallet menu", () => {
  it("offers the test USDC faucet and the MON faucet on testnet", async () => {
    state.faucet = { data: { usdc: USDC_TOKEN, limit: USDC(10_000) } };
    await renderWithProviders(<ConnectButton />, { connected: true });
    fireEvent.click(screen.getByRole("button", { name: /0x0000…00B0/ }));
    expect(screen.getByText("Testnet funds")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get 1,000 test USDC" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Get testnet MON for gas" })).toBeTruthy();
  });

  it("hides the faucet when the collateral is not our test USDC", async () => {
    await renderWithProviders(<ConnectButton />, { connected: true });
    fireEvent.click(screen.getByRole("button", { name: /0x0000…00B0/ }));
    expect(screen.queryByText("Testnet funds")).toBeNull();
  });
});
