import { type Deployment, deployments, type Network } from "@hunch-book/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector } from "wagmi";
import { DeployedGate } from "../src/components/DeployedGate";
import { LandingLive } from "../src/components/landing/LandingLive";
import { Footer } from "../src/components/layout/Footer";
import { Header } from "../src/components/layout/Header";
import { ActiveNetworkLabel, NetworkSwitch } from "../src/components/layout/NetworkSwitch";
import { PageHeader } from "../src/components/PageHeader";
import * as config from "../src/lib/config";
import {
  buildNetwork,
  NETWORK_STORAGE_KEY,
  networkOptions,
  parseNetwork,
  pickNetwork,
  readStoredNetwork,
  resolveNetwork,
  setActiveNetwork,
  storeNetwork,
  subscribeNetwork,
} from "../src/lib/config";
import { useCreateConfig } from "../src/lib/create/hooks";
import { readCreateConfig } from "../src/lib/create/reads";
import { chooseNetwork } from "../src/lib/wallet/appNetwork";
import { forActiveNetwork } from "../src/lib/wallet/useTxRunner";
import { renderWithProviders } from "./render";

// The create flow's factory read, so no test here talks to a real RPC.
vi.mock("@/lib/create/reads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/create/reads")>();
  return { ...actual, readCreateConfig: vi.fn(async () => ({ templates: {} })) };
});

const withMainnet: Record<Network, Deployment> = {
  ...deployments,
  "monad-mainnet": {
    ...deployments["monad-mainnet"],
    hunchBook: { factory: "0x00000000000000000000000000000000000000f9" },
  },
};

/** A Storage that throws on every call, like a browser with storage blocked. */
const blocked = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
} as unknown as Storage;

afterEach(() => {
  setActiveNetwork("monad-testnet");
  window.localStorage.clear();
});

describe("network names", () => {
  it("parses only known networks, and resolves the build default", () => {
    expect(parseNetwork(" Monad-Mainnet ")).toBe("monad-mainnet");
    expect(parseNetwork("ethereum")).toBeNull();
    expect(parseNetwork(null)).toBeNull();
    expect(resolveNetwork(undefined)).toBe("monad-testnet");
    expect(resolveNetwork("monad-mainnet")).toBe("monad-mainnet");
    expect(buildNetwork).toBe("monad-testnet");
  });
});

describe("network options", () => {
  it("offers testnet and shows mainnet as planned while its factory is missing", () => {
    expect(networkOptions()).toEqual([
      { network: "monad-testnet", label: "Monad testnet", deployed: true, selectable: true },
      { network: "monad-mainnet", label: "Monad mainnet", deployed: false, selectable: false },
    ]);
  });

  it("offers mainnet as soon as deployments/monad-mainnet.json has a factory", () => {
    expect(networkOptions(withMainnet).map((o) => o.selectable)).toEqual([true, true]);
  });

  it("always offers the build's own network, deployed or not", () => {
    const options = networkOptions(deployments, "monad-mainnet");
    expect(options.find((o) => o.network === "monad-mainnet")).toMatchObject({
      deployed: false,
      selectable: true,
    });
  });
});

describe("pickNetwork", () => {
  it("keeps a stored choice while it is selectable, else falls back to the build's network", () => {
    expect(pickNetwork("monad-mainnet", withMainnet)).toBe("monad-mainnet");
    expect(pickNetwork("monad-mainnet")).toBe("monad-testnet");
    expect(pickNetwork("garbage", withMainnet)).toBe("monad-testnet");
    expect(pickNetwork(null, withMainnet, "monad-mainnet")).toBe("monad-mainnet");
  });
});

describe("stored choice", () => {
  it("round-trips through localStorage", () => {
    storeNetwork("monad-mainnet");
    expect(window.localStorage.getItem(NETWORK_STORAGE_KEY)).toBe("monad-mainnet");
    expect(readStoredNetwork()).toBe("monad-mainnet");
    window.localStorage.setItem(NETWORK_STORAGE_KEY, "nonsense");
    expect(readStoredNetwork()).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    expect(readStoredNetwork(blocked)).toBeNull();
    expect(() => storeNetwork("monad-testnet", blocked)).not.toThrow();
    expect(readStoredNetwork(null)).toBeNull();
  });
});

describe("setActiveNetwork", () => {
  it("moves every live binding and tells subscribers", () => {
    const listener = vi.fn();
    const off = subscribeNetwork(listener);
    expect(setActiveNetwork("monad-mainnet")).toBe(true);
    expect(config.appNetwork).toBe("monad-mainnet");
    expect(config.appDeployment).toBe(deployments["monad-mainnet"]);
    expect(config.appChain.id).toBe(143);
    expect(config.appNetworkLabel).toBe("Monad mainnet");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(setActiveNetwork("monad-mainnet")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    setActiveNetwork("monad-testnet");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(config.appChain.id).toBe(10143);
  });

  it("points refresh keys built for one network at the active one", () => {
    expect(forActiveNetwork(["portfolio", "monad-testnet", "0xab"])).toEqual([
      "portfolio",
      "monad-testnet",
      "0xab",
    ]);
    setActiveNetwork("monad-mainnet");
    expect(forActiveNetwork(["portfolio", "monad-testnet", "0xab"])).toEqual([
      "portfolio",
      "monad-mainnet",
      "0xab",
    ]);
    expect(forActiveNetwork(["tape"])).toEqual(["tape"]);
    expect(forActiveNetwork(["x", "not-a-network"])).toEqual(["x", "not-a-network"]);
  });
});

describe("chooseNetwork", () => {
  it("switches the app, remembers it, and asks a connected wallet to follow", async () => {
    const request = vi.fn(async () => null);
    const connector = { getProvider: async () => ({ request }) } as unknown as Connector;
    await chooseNetwork("monad-mainnet", { connector, chainId: 10143 });
    expect(config.appNetwork).toBe("monad-mainnet");
    expect(readStoredNetwork()).toBe("monad-mainnet");
    expect(request.mock.calls.map((c) => (c as unknown as [{ method: string }])[0].method)).toEqual([
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(request).toHaveBeenLastCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x8f" }],
    });
  });

  it("does not prompt a wallet already on the chain, or when none is connected", async () => {
    const request = vi.fn(async () => null);
    const connector = { getProvider: async () => ({ request }) } as unknown as Connector;
    await chooseNetwork("monad-testnet", { connector, chainId: 10143 });
    await chooseNetwork("monad-testnet");
    expect(request).not.toHaveBeenCalled();
  });

  it("still switches the app when the person says no in the wallet", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    const connector = { getProvider: async () => ({ request }) } as unknown as Connector;
    await chooseNetwork("monad-mainnet", { connector, chainId: 10143 });
    expect(config.appNetwork).toBe("monad-mainnet");
  });
});

describe("NetworkSwitch", () => {
  it("shows the active network and mainnet as planned, with how it ships", async () => {
    await renderWithProviders(<NetworkSwitch />);
    const trigger = screen.getByRole("button", { name: "Network: Monad testnet" });
    expect(trigger.textContent).toContain("Testnet");
    fireEvent.click(trigger);
    const testnet = screen.getByRole("button", { name: /^Monad testnet/ });
    expect(testnet.getAttribute("aria-pressed")).toBe("true");
    expect(within(testnet).getByText("selected")).toBeTruthy();
    expect(screen.getByText("Mainnet: planned")).toBeTruthy();
    expect(screen.getByRole("link", { name: /How it ships/ }).getAttribute("href")).toMatch(
      /docs\/DEPLOY\.md$/,
    );
    // Picking the network already active just closes the menu.
    fireEvent.click(testnet);
    expect(screen.queryByText("Mainnet: planned")).toBeNull();
  });

  it("follows a switch made elsewhere", async () => {
    await renderWithProviders(<NetworkSwitch />);
    act(() => {
      setActiveNetwork("monad-mainnet");
    });
    expect(screen.getByRole("button", { name: "Network: Monad mainnet" })).toBeTruthy();
  });
});

describe("after a network switch, what the server rendered follows it", () => {
  it("page eyebrows, the brand, the footer's contracts, the menu and the not-deployed gate", async () => {
    await renderWithProviders(
      <>
        <Header />
        <PageHeader eyebrow={<ActiveNetworkLabel suffix=" · Verify" />} title="Settlement" />
        <DeployedGate willShow={["Every market from the factory."]}>
          <p>Markets go here</p>
        </DeployedGate>
        <Footer />
      </>,
    );
    expect(screen.getByText("Monad testnet · Verify")).toBeTruthy();
    const banner = () => within(screen.getByRole("banner"));
    expect(banner().getByRole("link", { name: "Hunch Book on testnet, home" })).toBeTruthy();
    expect(screen.getByText("Markets go here")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contracts on Monad testnet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Factory/ }).getAttribute("href")).toMatch(/testnet\.monadscan/);

    act(() => {
      setActiveNetwork("monad-mainnet");
    });
    expect(screen.getByText("Monad mainnet · Verify")).toBeTruthy();
    expect(banner().getByRole("link", { name: "Hunch Book, home" })).toBeTruthy();
    expect(screen.queryByText("Markets go here")).toBeNull();
    expect(screen.getByRole("heading", { name: "Contracts not deployed on Monad mainnet yet" })).toBeTruthy();
    expect(screen.getByText("Every market from the factory.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contracts on Monad mainnet" })).toBeTruthy();
    expect(screen.getByText("Factory: not deployed yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Every address/ }).getAttribute("href")).toMatch(
      /deployments\/monad-mainnet\.json$/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(within(screen.getByRole("dialog")).getByText("Monad mainnet: not deployed yet")).toBeTruthy();
  });

  it("the landing page reads the network it switched to itself", async () => {
    await renderWithProviders(<LandingLive initial={{ status: "error" }} />);
    expect(screen.getByText("Could not reach Monad testnet just now.")).toBeTruthy();
    act(() => {
      setActiveNetwork("monad-mainnet");
    });
    // Mainnet has no factory yet, so its read answers at once without a network call.
    expect(await screen.findByText("The contracts are not deployed on Monad mainnet yet.")).toBeTruthy();
    expect(screen.queryByText("Could not reach Monad testnet just now.")).toBeNull();
  });

  it("the create flow's reads follow the active network's deployment", async () => {
    vi.mocked(readCreateConfig).mockClear();
    setActiveNetwork("monad-mainnet");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(() => useCreateConfig(), { wrapper });
    // No factory on mainnet: the read stays off.
    expect(result.current.fetchStatus).toBe("idle");
    expect(readCreateConfig).not.toHaveBeenCalled();
    act(() => {
      setActiveNetwork("monad-testnet");
    });
    rerender();
    await waitFor(() => expect(readCreateConfig).toHaveBeenCalledTimes(1));
  });
});
