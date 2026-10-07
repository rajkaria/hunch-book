import { type Address, getAddress, isAddress } from "viem";
import type { Maker } from "./bot.js";
import { describeConfig, loadEnvFile, parseConfig, REPO_ENV_FILE } from "./config.js";
import { errorMessage, log } from "./log.js";
import { buildMakers } from "./stacks.js";

// Usage: tsx src/main.ts <run | once | cancel-all> [--env-file <path>] [--book <address> ...]
//   run         quote until SIGINT/SIGTERM, then cancel everything and exit
//   once        one cycle, then exit (orders stay on the book)
//   cancel-all  cancel every order of ours on every Hunch book (plus any --book) and withdraw margin

function parseArgs(argv: string[]): { mode: string; envFile: string | undefined; books: Address[] } {
  const [mode = "run", ...rest] = argv;
  let envFile: string | undefined;
  const books: Address[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === "--env-file" && value) {
      envFile = value;
      i++;
    } else if (arg === "--book" && value && isAddress(value)) {
      books.push(getAddress(value));
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["run", "once", "cancel-all"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  return { mode, envFile, books };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envFile = args.envFile ?? process.env.MAKER_ENV_FILE ?? REPO_ENV_FILE;
  const loaded = loadEnvFile(envFile);
  const config = parseConfig(process.env);
  const makers = buildMakers(config);
  const maker = makers[0] as Maker;
  log("start", {
    mode: args.mode,
    envFile,
    envLoaded: loaded,
    maker: maker.maker,
    ...describeConfig(config),
    stacks: makers.map((m) => ({ stack: m.stackName, kuruVersion: m.kuruVersion })),
  });
  maker.checkPublishedAddress();

  // --book applies to the bot of the stack the books belong to; each bot cancels on its own books too.
  const each = async (fn: (m: Maker) => Promise<void>) => {
    for (const m of makers) await fn(m);
  };
  if (args.mode === "cancel-all") {
    await each((m) => m.cancelEverything("cancel-all", m.kuruVersion === 1 ? args.books : []));
    return;
  }
  if (args.mode === "once") {
    await each((m) => m.cycle());
    return;
  }

  if (config.healthPort) {
    maker.health.serve(
      config.healthPort,
      Object.fromEntries(makers.slice(1).map((m) => [m.stackName, m.health])),
    );
  }
  const stop = new AbortController();
  let signals = 0;
  const onSignal = (signal: string) => {
    signals += 1;
    if (signals > 1) {
      log("forced-exit", { signal }, "warn");
      process.exit(1);
    }
    log("stopping", { signal, note: "cancelling every order before exit; send again to force" });
    stop.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  while (!stop.signal.aborted) {
    // One stack after another, so the bot's transactions never race for a nonce.
    for (const m of makers) {
      try {
        await m.cycle();
      } catch (error) {
        const message = errorMessage(error);
        log("cycle-error", { stack: m.stackName, error: message }, "error");
        m.health.update({ lastError: message });
      }
    }
    await sleep(config.pollSeconds * 1000, stop.signal);
  }
  await each((m) => m.cancelEverything("shutdown", m.kuruVersion === 1 ? args.books : []));
  maker.health.close();
  log("stopped", {});
}

main().catch((error) => {
  log("fatal", { error: errorMessage(error) }, "error");
  process.exitCode = 1;
});
