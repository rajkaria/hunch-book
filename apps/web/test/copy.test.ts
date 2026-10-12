import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Copy rules checked over the app's source, for claims a unit test of one component would miss.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("app copy", () => {
  it("never promises the watchdog a fixed interval: GitHub's scheduler runs it every few hours", () => {
    // The workflow asks for every 30 minutes; GitHub has run it every 3 to 7 hours. Say "on a schedule".
    const promise = /(watchdog|liveness|health check)[^\n]{0,160}\bevery \d+ (minutes?|hours?)\b/i;
    const offenders = sources(SRC).filter((file) => promise.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("says Live on Monad mainnet, never that only the contracts are live, now that mainnet has a market", () => {
    const offenders = sources(SRC).filter((file) =>
      /contracts live on Monad mainnet/i.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
