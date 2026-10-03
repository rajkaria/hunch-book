import type { Chain } from "viem";
import { type CreateConnectorFn, createConfig, http, injected } from "wagmi";
import { appChain, appDeployment } from "../config";

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

const chain: Chain = appChain;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: buildConnectors(),
  transports: { [chain.id]: http(appDeployment.rpc) },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
