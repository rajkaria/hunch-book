import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Run against the shared package's source, so tests never depend on a stale build.
    alias: {
      "@hunch-book/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    // The fork suites each start an anvil fork of Monad testnet; one at a time keeps the public RPC happy.
    fileParallelism: false,
  },
});
