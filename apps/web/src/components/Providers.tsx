"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { WagmiProvider } from "wagmi";
import { NetworkBoundary } from "@/lib/wallet/appNetwork";
import { wagmiConfig } from "@/lib/wallet/config";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // "always": reads and writes run whatever navigator.onLine says. Some browsers and in-app webviews
      // report offline while requests go through, and in the default mode every query would wait
      // forever on "Loading". A real outage still shows, as the RPC call failing after its retries.
      queries: {
        staleTime: 4_000,
        retry: 2,
        refetchOnWindowFocus: true,
        networkMode: "always",
      },
      mutations: { networkMode: "always" },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <NetworkBoundary>{children}</NetworkBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
