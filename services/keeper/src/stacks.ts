import {
  type Deployment,
  defaultStackOf,
  deploymentForStack,
  loadDeployment,
  stacksOf,
} from "@hunch-book/shared";
import type { Address } from "viem";
import { configForStack, type KeeperConfig } from "./config.js";
import { Keeper, type KeeperDeps } from "./keeper.js";
import { log } from "./log.js";

/**
 * One keeper per deployed stack (the primary first), or only the stacks in KEEPER_STACKS. A network with
 * no factory yet gets one idle keeper, as before. Each keeper works on its stack's view of the
 * deployment (deploymentForStack): on a stack with a Hunch venue, `external.kuru` is Hunch Book's own
 * book factory and margin account. The series job runs on the default stack only (`defaultStack`, the
 * primary stack when absent).
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
  const seriesStack = defaultStackOf(deployment)?.name;
  if (config.seriesFile && !stacks.some((s) => s.name === seriesStack)) {
    log(
      "series-off",
      {
        defaultStack: seriesStack,
        stacks: stacks.map((s) => s.name),
        note: "series create markets on the default stack only, and KEEPER_STACKS leaves it out",
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
