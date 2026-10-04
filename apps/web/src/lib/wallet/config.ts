import type { Chain } from "viem";
import { type CreateConnectorFn, createConfig, http, injected } from "wagmi";
import { passkeyConnector } from "../account/connector";
import { appChain, appDeployment } from "../config";

/**
 * Wallet connectors: browser wallets (MetaMask, Rabby and any EIP-6963 wallet), and passkey accounts
 * (Mera, PROTOCOL.md §9.5, docs/ACCOUNTS.md). A passkey account is a plain EOA derived in the
 * browser, so it is one more wagmi connector: every hook and the tx runner work with it unchanged.
 */
export function buildConnectors(): CreateConnectorFn[] {
  return [injected({ shimDisconnect: true }), passkeyConnector()];
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
