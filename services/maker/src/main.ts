import { type Address, getAddress, isAddress } from "viem";
import { Maker } from "./bot.js";
import { describeConfig, loadEnvFile, parseConfig, REPO_ENV_FILE } from "./config.js";
import { errorMessage, log } from "./log.js";

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
  const maker = new Maker(config);
  log("start", {
    mode: args.mode,
    envFile,
    envLoaded: loaded,
    maker: maker.maker,
    ...describeConfig(config),
  });
  maker.checkPublishedAddress();

  if (args.mode === "cancel-all") {
    await maker.cancelEverything("cancel-all", args.books);
    return;
  }
  if (args.mode === "once") {
    await maker.cycle();
    return;
  }

  if (config.healthPort) maker.health.serve(config.healthPort);
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
    try {
      await maker.cycle();
    } catch (error) {
      const message = errorMessage(error);
      log("cycle-error", { error: message }, "error");
      maker.health.update({ lastError: message });
    }
    await sleep(config.pollSeconds * 1000, stop.signal);
  }
  await maker.cancelEverything("shutdown", args.books);
  maker.health.close();
  log("stopped", {});
}

main().catch((error) => {
  log("fatal", { error: errorMessage(error) }, "error");
  process.exitCode = 1;
});
