import { type Deployment, deploymentForStack, loadDeployment, stacksOf } from "@hunch-book/shared";
import { configForStack, type KeeperConfig } from "./config.js";
import { Keeper, type KeeperDeps } from "./keeper.js";

/**
 * One keeper per deployed stack (the primary first), or only the stacks in KEEPER_STACKS. A network with
 * no factory yet gets one idle keeper, as before.
 */
export function buildKeepers(
  config: KeeperConfig,
  deployment: Deployment = loadDeployment(config.network),
  deps: Omit<KeeperDeps, "stack"> = {},
): Keeper[] {
  const stacks = stacksOf(deployment).filter((s) => !config.stacks || config.stacks.includes(s.name));
  if (config.stacks) {
    const missing = config.stacks.filter((name) => !stacks.some((s) => s.name === name));
    if (missing.length > 0)
      throw new Error(`KEEPER_STACKS names stacks that are not deployed: ${missing.join(", ")}`);
  }
  if (stacks.length === 0) return [new Keeper(config, deployment, deps)];
  return stacks.map(
    (s) =>
      new Keeper(configForStack(config, s), deploymentForStack(deployment, s), {
        ...deps,
        stack: { name: s.name, primary: s.primary },
      }),
  );
}
