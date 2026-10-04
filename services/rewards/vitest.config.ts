import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Run against the workspace packages' source, so tests never depend on a stale build.
    alias: {
      "@hunch-book/shared": here("../../packages/shared/src/index.ts"),
      "@hunch-book/sdk": here("../../packages/sdk/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
