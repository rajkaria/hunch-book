import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${here("./src")}/` },
      // Test against the shared package's source, so `pnpm test` needs no prior build.
      { find: /^@hunch-book\/shared$/, replacement: here("../../packages/shared/src/index.ts") },
    ],
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
