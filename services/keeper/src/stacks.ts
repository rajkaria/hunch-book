import {
  type Deployment,
  defaultStackOf,
  deploymentForStack,
  loadDeployment,
  type Stack,
  stacksOf,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { configForStack, type KeeperConfig } from "./config.js";
import { Keeper, type KeeperDeps } from "./keeper.js";
import { log } from "./log.js";

/**
 * The stack the series job creates markets on: Kuru only, never Hunch Book's own order book (the `hunch`
 * stack is our fallback book, for earlier markets). That is the default stack (`defaultStack`, the
 * primary stack when absent) when its books are on Kuru. If the default stack is a Hunch venue, series go
 * to the first Kuru v1 stack instead (the primary first), else the first Kuru v2 one. Undefined when no
 * Kuru stack is deployed: then no stack runs series.
 */
export function seriesStackOf(deployment: Deployment): Stack | undefined {
  const fresh = defaultStackOf(deployment);
  if (fresh?.venue === "kuru") return fresh;
  const kuru = stacksOf(deployment).filter((s) => s.venue === "kuru");
  return kuru.find((s) => s.kuruVersion === 1) ?? kuru[0];
}

/**
 * One keeper per deployed stack (the primary first), or only the stacks in KEEPER_STACKS. A network with
 * no factory yet gets one idle keeper, as before. Each keeper works on its stack's view of the
 * deployment (deploymentForStack): on a stack with a Hunch venue, `external.kuru` is Hunch Book's own
 * book factory and margin account. The series job runs on one Kuru stack only (seriesStackOf).
 */
export function buildKeepers(
  config: KeeperConfig,
  deployment: Deployment = loadDeployment(config.network),
  deps: Omit<KeeperDeps, "stack"> = {},
): Keeper[] {
  const deployed = stacksOf(deployment);
  const stacks = deployed.filter((s) => !config.stacks || config.stacks.includes(s.name));
  if (config.stacks) {
    const missing = config.stacks.filter((name) => !stacks.some((s) => s.name === name));
    if (missing.length > 0)
      throw new Error(`KEEPER_STACKS names stacks that are not deployed: ${missing.join(", ")}`);
  }
  if (stacks.length === 0) return [new Keeper(config, deployment, deps)];
  const seriesStack = seriesStackOf(deployment)?.name;
  if (config.seriesFile && !stacks.some((s) => s.name === seriesStack)) {
    log(
      "series-off",
      {
        seriesStack: seriesStack ?? null,
        defaultStack: defaultStackOf(deployment)?.name ?? null,
        stacks: stacks.map((s) => s.name),
        note:
          seriesStack === undefined
            ? "series create markets on a Kuru stack only, and none is deployed"
            : "series create markets on one Kuru stack only, and KEEPER_STACKS leaves it out",
      },
      "warn",
    );
  }
  return stacks.map(
    (s) =>
      new Keeper(configForStack(config, s), deploymentForStack(deployment, s), {
        ...deps,
        stack: {
          name: s.name,
          primary: s.primary,
          series: s.name === seriesStack,
          otherFactories: deployed
            .filter((o) => o.name !== s.name)
            .map((o) => o.contracts.factory as Address),
        },
      }),
  );
}
