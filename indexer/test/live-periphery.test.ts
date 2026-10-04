// Opt-in, like live.test.ts: indexes the real Monad testnet blocks where the periphery was deployed and
// template 7 was registered, through the generated config, so the event signatures are checked against
// logs the contracts really emitted (the simulated tests hand the handlers decoded logs directly).
//
//   INDEXER_LIVE_TESTNET=1 INDEXER_ENV_FILE=/path/to/.env \
//     pnpm --filter @hunch-book/indexer exec vitest run test/live-periphery.test.ts
import { createTestIndexer } from "envio";
import { beforeAll, describe, expect, it } from "vitest";
import { envioEnv } from "../scripts/envio.js";
import { networkOf } from "../src/lib/network.js";

const live = Boolean(process.env.INDEXER_LIVE_TESTNET);
const testnet = networkOf(10143);

/** Blocks of the deployment transactions under hunchBook.periphery.deployTxs and deployTxs.addTemplate7. */
const PERIPHERY_DEPLOYED = { startBlock: 68_046_230, endBlock: 68_046_255 };
const TEMPLATE_7_ADDED = { startBlock: 68_083_590, endBlock: 68_083_610 };

describe.skipIf(!live)("live: Monad testnet periphery and template 7", () => {
  beforeAll(() => {
    if (process.env.INDEXER_ENV_FILE) process.loadEnvFile(process.env.INDEXER_ENV_FILE);
    Object.assign(process.env, envioEnv(process.env, "testnet").env);
  });

  it("reads the distributor's funder from its constructor and template 7's registration", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: PERIPHERY_DEPLOYED } });
    const distributor = await indexer.RewardDistributor.getOrThrow(
      testnet.periphery.merkleDistributor as string,
    );
    expect(distributor).toMatchObject({
      funder: testnet.ours.distributorFunder,
      funderIsOurs: true,
      pendingFunder: undefined,
    });

    await indexer.process({ chains: { 10143: TEMPLATE_7_ADDED } });
    expect(await indexer.Template.getOrThrow("7")).toMatchObject({
      templateId: 7n,
      resolver: testnet.resolvers.snapshot,
    });
  }, 600_000);
});
