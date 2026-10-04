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
    hookTimeout: 120_000,
    // The integration suite starts its own anvil; one file at a time keeps ports and logs simple.
    fileParallelism: false,
  },
});
