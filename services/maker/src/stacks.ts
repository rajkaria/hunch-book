import { type Deployment, deploymentForStack, loadDeployment, stacksOf } from "@hunch-book/shared";
import { Maker } from "./bot.js";
import { configForStack, type MakerConfig } from "./config.js";

/**
 * One bot per deployed stack (the primary first), or only the stacks in MAKER_STACKS. Each quotes the
 * markets of its own factory, on its stack's Kuru version. A network with no factory yet gets one idle bot.
 */
export function buildMakers(
  config: MakerConfig,
  deployment: Deployment = loadDeployment(config.network),
): Maker[] {
  const stacks = stacksOf(deployment).filter((s) => !config.stacks || config.stacks.includes(s.name));
  if (config.stacks) {
    const missing = config.stacks.filter((name) => !stacks.some((s) => s.name === name));
    if (missing.length > 0)
      throw new Error(`MAKER_STACKS names stacks that are not deployed: ${missing.join(", ")}`);
  }
  if (stacks.length === 0) return [new Maker(config, deployment)];
  return stacks.map(
    (s) => new Maker(configForStack(config, s), deploymentForStack(deployment, s), { name: s.name }),
  );
}
