import { describeConfig, loadEnvFile, parseConfig, REPO_ENV_FILE } from "./config.js";
import type { Keeper } from "./keeper.js";
import { errorMessage, log, setLogContext } from "./log.js";
import { buildKeepers } from "./stacks.js";

// Usage: tsx src/main.ts <run | once> [--env-file <path>]
//   run   keep every market moving until SIGINT/SIGTERM (finishes the current cycle, then exits)
//   once  one cycle with every plan line printed, then exit (with KEEPER_ENABLED off: a dry run)

function parseArgs(argv: string[]): { mode: string; envFile: string | undefined } {
  const [mode = "run", ...rest] = argv;
  let envFile: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === "--env-file" && value) {
      envFile = value;
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["run", "once"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  return { mode, envFile };
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
  const envFile = args.envFile ?? process.env.KEEPER_ENV_FILE ?? REPO_ENV_FILE;
  const loaded = loadEnvFile(envFile);
  const config = parseConfig(process.env);
  const keepers = buildKeepers(config);
  const keeper = keepers[0] as Keeper;
  log("start", {
    mode: args.mode,
    envFile,
    envLoaded: loaded,
    keeper: keeper.keeper,
    ...describeConfig(config),
    stacks: keepers.map((k) => ({ stack: k.stackName, kuruVersion: k.kuruVersion })),
    templates: keeper.settlers.templates(),
    cycleJobs: keepers.map((k) => ({ stack: k.stackName, jobs: k.cycleJobs.map((j) => j.name) })),
  });
  keeper.checkPublishedAddress();

  if (args.mode === "once") {
    for (const k of keepers) {
      k.verbosePlan = true;
      setLogContext(keepers.length > 1 ? { stack: k.stackName } : {});
      const summary = await k.cycle();
      log("cycle", { ...summary, enabled: config.enabled });
    }
    return;
  }

  if (config.healthPort) {
    const others = Object.fromEntries(keepers.slice(1).map((k) => [k.stackName, k.health]));
    keeper.health.serve(config.healthPort, others);
  }
  const stop = new AbortController();
  let signals = 0;
  const onSignal = (signal: string) => {
    signals += 1;
    if (signals > 1) {
      log("forced-exit", { signal }, "warn");
      process.exit(1);
    }
    log("stopping", { signal, note: "finishing the current cycle; send again to force" });
    stop.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  while (!stop.signal.aborted) {
    // One stack after another, so the keeper's transactions never race for a nonce.
    for (const k of keepers) {
      if (stop.signal.aborted) break;
      setLogContext(keepers.length > 1 ? { stack: k.stackName } : {});
      try {
        const summary = await k.cycle();
        if (summary.sent > 0) log("cycle", { ...summary });
      } catch (error) {
        k.jobFailed("discover", undefined, error);
        k.health.update({});
      }
    }
    setLogContext({});
    await sleep(config.pollSeconds * 1000, stop.signal);
  }
  for (const k of keepers) k.store?.save();
  keeper.health.close();
  log("stopped", {});
}

main().catch((error) => {
  log("fatal", { error: errorMessage(error) }, "error");
  process.exitCode = 1;
});
