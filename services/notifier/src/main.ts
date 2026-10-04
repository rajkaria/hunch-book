import { chainsByNetwork } from "@hunch-book/shared";
import { createPublicClient, http } from "viem";
import { describeConfig, loadEnvFile, parseConfig, REPO_ENV_FILE, secretsOf } from "./config.js";
import { errorMessage, log, setRedactions } from "./log.js";
import { Notifier } from "./notifier.js";
import { DryRunMessenger, TelegramClient } from "./telegram.js";

// Usage: tsx src/main.ts <run | once> [--env-file <path>]
//   run   watch the chain and answer commands until SIGINT/SIGTERM
//   once  one cycle, then exit (prints what it would send in dry run)

function parseArgs(argv: string[]): { mode: string; envFile: string | undefined } {
  const [mode = "run", ...rest] = argv;
  let envFile: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--env-file" && rest[i + 1]) {
      envFile = rest[i + 1];
      i++;
    } else {
      throw new Error(`unknown argument: ${rest[i]}`);
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
  const envFile = args.envFile ?? process.env.NOTIFIER_ENV_FILE ?? REPO_ENV_FILE;
  const loaded = loadEnvFile(envFile);
  const config = parseConfig(process.env);
  setRedactions(secretsOf(config));
  const client = createPublicClient({
    chain: chainsByNetwork[config.network],
    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
  const telegram = config.live && config.telegramToken ? new TelegramClient(config.telegramToken) : null;
  const notifier = new Notifier(config, {
    client: client as never,
    messenger: telegram ?? new DryRunMessenger(),
    telegram,
  });
  log("start", { mode: args.mode, envFile, envLoaded: loaded, ...describeConfig(config) });
  if (!config.live) {
    log(
      "dry-run",
      {
        reason: config.enabled ? "TELEGRAM_BOT_TOKEN is not set" : "NOTIFIER_ENABLED is off",
        note: "messages are printed, not sent, and Telegram commands are not read",
      },
      "warn",
    );
  }

  if (args.mode === "once") {
    log("cycle", { ...(await notifier.cycle()) });
    return;
  }

  if (config.healthPort) notifier.health.serve(config.healthPort);
  const stop = new AbortController();
  let signals = 0;
  const onSignal = (signal: string) => {
    signals += 1;
    if (signals > 1) process.exit(1);
    log("stopping", { signal });
    stop.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const listening = notifier.listen(stop.signal);
  while (!stop.signal.aborted) {
    try {
      const summary = await notifier.cycle();
      if (summary.events > 0 || summary.sent > 0) log("cycle", { ...summary });
    } catch (error) {
      log("cycle-failed", { error: errorMessage(error) }, "error");
      notifier.health.error(errorMessage(error));
    }
    await sleep(config.pollSeconds * 1000, stop.signal);
  }
  await Promise.race([listening, new Promise((r) => setTimeout(r, 2_000))]);
  notifier.health.close();
  log("stopped", {});
  process.exit(0);
}

main().catch((error) => {
  log("fatal", { error: errorMessage(error) }, "error");
  process.exitCode = 1;
});
