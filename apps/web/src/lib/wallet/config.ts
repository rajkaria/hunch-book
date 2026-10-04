import { chainsByNetwork, deployments } from "@hunch-book/shared";
import type { Chain, Transport } from "viem";
import { type CreateConnectorFn, createConfig, http, injected } from "wagmi";
import { buildNetwork, networkOptions } from "../config";

/**
 * Wallet connectors. Today: browser wallets (MetaMask, Rabby and any EIP-6963 wallet).
 *
 * Seam for passkey accounts (Mera, PROTOCOL.md §9.5), planned and not built: a Mera passkey account
 * is a plain EOA derived in the browser, so it joins this list as one more wagmi connector made with
 * `createConnector`. Nothing else in the app changes: every hook reads the active connector.
 */
export function buildConnectors(): CreateConnectorFn[] {
  return [injected({ shimDisconnect: true })];
}

// Every network the switch can select, the build's own first, so writes can target whichever is active.
const selectable = networkOptions().filter((o) => o.selectable);
const ordered = [buildNetwork, ...selectable.map((o) => o.network).filter((n) => n !== buildNetwork)];
const chains = ordered.map((n): Chain => chainsByNetwork[n]) as unknown as readonly [Chain, ...Chain[]];
const transports: Record<number, Transport> = Object.fromEntries(
  ordered.map((n) => [chainsByNetwork[n].id, http(deployments[n].rpc)]),
);

export const wagmiConfig = createConfig({
  chains,
  connectors: buildConnectors(),
  transports,
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
