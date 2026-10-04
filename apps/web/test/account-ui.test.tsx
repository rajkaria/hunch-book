import { monadTestnet, Phase, Side } from "@hunch-book/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { parseEther } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfig, http, mock, WagmiProvider } from "wagmi";
import { connect } from "wagmi/actions";
import { GasHelp } from "../src/components/account/AccountPanel";
import { GaslessStake } from "../src/components/account/GaslessStake";
import { ConnectButton, pickConnectors } from "../src/components/wallet/ConnectButton";
import { passkeyConnector } from "../src/lib/account/connector";
import { makeMarket, USDC, USER } from "./fixtures";

// The account UI against mocked reads: the passkey section of the connect menu, gas help, and the
// stake-without-MON box under the stake button.

type Q = { data?: unknown };
const state = vi.hoisted(() => ({
  mon: {} as { data?: bigint },
  drip: {} as Q,
  relay: {} as Q,
  stake: vi.fn(async () => true),
  ask: vi.fn(async () => undefined),
  support: { supported: true, prf: "yes" } as unknown,
}));

vi.mock("@/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hooks")>();
  return {
    ...actual,
    useMonBalance: () => ({ data: state.mon.data, isPending: state.mon.data === undefined }),
    useTestUsdcFaucet: () => ({ data: undefined }),
    useProtocolAddresses: () => ({
      data: {
        vault: "0x00000000000000000000000000000000000000aa",
        usdc: "0x00000000000000000000000000000000000000ab",
      },
    }),
  };
});

vi.mock("@/lib/relayer/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/relayer/hooks")>();
  return {
    ...actual,
    useDripStatus: () => ({ data: state.drip.data }),
    useRelayStatus: () => ({ data: state.relay.data }),
    useRelayedStake: () => ({ stake: state.stake, stage: "idle", error: null, txs: [], busy: false }),
  };
});

vi.mock("@/lib/account/gas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/account/gas")>();
  return { ...actual, useAskForGas: () => state.ask };
});

vi.mock("@/lib/account/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/account/hooks")>();
  return { ...actual, usePasskeySupport: () => state.support };
});

async function renderWith(ui: ReactElement, { connected = false } = {}) {
  const config = createConfig({
    chains: [monadTestnet],
    connectors: [mock({ accounts: [USER] }), passkeyConnector({ signIn: vi.fn() })],
    transports: { [monadTestnet.id]: http("http://127.0.0.1:9") },
    multiInjectedProviderDiscovery: false,
    storage: null,
  });
  const first = config.connectors[0];
  if (connected && first) await connect(config, { connector: first });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </WagmiProvider>,
  );
}

beforeEach(() => {
  state.mon = {};
  state.drip = {};
  state.relay = {};
  state.stake.mockClear();
  state.ask.mockClear();
  state.support = { supported: true, prf: "yes" };
});

describe("connect menu", () => {
  it("keeps the passkey connector out of the browser-wallet list", () => {
    const named = { id: "io.rabby", name: "Rabby", type: "injected" };
    const passkey = { id: "hunch-passkey", name: "Passkey account", type: "passkey" };
    const generic = { id: "injected", name: "Injected", type: "injected" };
    expect(pickConnectors([named, passkey, generic] as never, true)).toEqual([named]);
    expect(pickConnectors([passkey, generic] as never, true)).toEqual([generic]);
    expect(pickConnectors([passkey, generic] as never, false)).toEqual([]);
  });

  it("offers to create a passkey account or sign in, and says passkeys belong to one site", async () => {
    await renderWith(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByText("Passkey account")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a passkey account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeTruthy();
    expect(screen.getByText(/No seed phrase and no extension/)).toBeTruthy();
    expect(screen.getByText(/A passkey belongs to one website/)).toBeTruthy();
  });

  it("explains instead of offering buttons where passkeys cannot work", async () => {
    state.support = { supported: false, reason: "Passkeys need a secure page (https or localhost)." };
    await renderWith(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.queryByRole("button", { name: "Create a passkey account" })).toBeNull();
    expect(screen.getByText("Passkeys need a secure page (https or localhost).")).toBeTruthy();
  });
});

describe("gas help", () => {
  it("shows nothing when the account has MON", async () => {
    await renderWith(<GasHelp address={USER} mon={parseEther("1")} />);
    expect(screen.queryByText(/MON/)).toBeNull();
  });

  it("offers the drip when it runs here", async () => {
    state.drip = { data: { enabled: true, amountMon: "0.05" } };
    await renderWith(<GasHelp address={USER} mon={0n} />);
    fireEvent.click(screen.getByRole("button", { name: "Get 0.05 MON for gas" }));
    expect(state.ask).toHaveBeenCalledWith(USER);
  });

  it("falls back to the faucet when the drip is not set up", async () => {
    state.drip = { data: { enabled: false, reason: "not-configured" } };
    await renderWith(<GasHelp address={USER} mon={0n} />);
    expect(screen.getByText(/You need a little MON to pay for gas/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Get testnet MON from the faucet" })).toBeTruthy();
  });
});

describe("stake without MON", () => {
  const m = makeMarket({ phase: Phase.Pool });

  it("stays hidden while the account has gas", async () => {
    state.mon = { data: parseEther("1") };
    await renderWith(<GaslessStake m={m} side={Side.Yes} amount={USDC(10)} ready />, { connected: true });
    expect(screen.queryByText("No MON for gas?")).toBeNull();
  });

  it("relays a signed stake when the account has no MON", async () => {
    state.mon = { data: 0n };
    state.relay = { data: { enabled: true, maxStake: "1000000000" } };
    await renderWith(<GaslessStake m={m} side={Side.No} amount={USDC(10)} ready />, { connected: true });
    const button = screen.getByRole("button", { name: "Stake 10.00 USDC on NO without MON" });
    fireEvent.click(button);
    expect(state.stake).toHaveBeenCalledWith(
      expect.objectContaining({ market: m.address, side: Side.No, amount: USDC(10) }),
    );
    expect(screen.getByText(/this market, this side and this amount only/)).toBeTruthy();
  });

  it("refuses amounts over the relayer's limit", async () => {
    state.mon = { data: 0n };
    state.relay = { data: { enabled: true, maxStake: "5000000" } };
    await renderWith(<GaslessStake m={m} side={Side.Yes} amount={USDC(10)} ready />, { connected: true });
    expect(screen.getByText("The relayer takes stakes of up to 5.00 USDC.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Stake 10.00 USDC on YES without MON" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("says the person needs a little MON when relaying is off", async () => {
    state.mon = { data: 0n };
    state.relay = { data: { enabled: false } };
    state.drip = { data: { enabled: false } };
    await renderWith(<GaslessStake m={m} side={Side.Yes} amount={USDC(10)} ready />, { connected: true });
    expect(screen.getByText(/You need a little MON to pay for gas/)).toBeTruthy();
  });
});
