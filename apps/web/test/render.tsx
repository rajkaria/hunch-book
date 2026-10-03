import { monadTestnet } from "@hunch-book/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createConfig, http, mock, WagmiProvider } from "wagmi";
import { connect } from "wagmi/actions";
import { USER } from "./fixtures";

/** A wagmi config with a mock wallet and an RPC that is never called. */
export function makeTestConfig() {
  return createConfig({
    chains: [monadTestnet],
    connectors: [mock({ accounts: [USER] })],
    transports: { [monadTestnet.id]: http("http://127.0.0.1:9") },
    multiInjectedProviderDiscovery: false,
    storage: null,
  });
}

export async function renderWithProviders(
  ui: ReactElement,
  { connected = false }: { connected?: boolean } = {},
) {
  const config = makeTestConfig();
  const connector = config.connectors[0];
  if (connected && connector) await connect(config, { connector });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </WagmiProvider>,
  );
}
