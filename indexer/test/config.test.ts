// The generated config and network files cannot drift from deployments/ or from the handlers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contractEvents,
  eventSignature,
  INDEXER_DIR,
  isDeployed,
  networkConstants,
  renderAll,
  renderConfig,
  stacksOf,
  staleFiles,
  staticContracts,
} from "../scripts/gen-config.js";

const deployment = (network: string) =>
  JSON.parse(readFileSync(join(INDEXER_DIR, "..", "deployments", `${network}.json`), "utf8"));

describe("generated config", () => {
  it("is up to date with deployments/ (run gen-config if this fails)", () => {
    expect(staleFiles()).toEqual([]);
  });

  it("indexes testnet from the deploy block with every static address from the deployments file", () => {
    const d = deployment("monad-testnet");
    const config = readFileSync(join(INDEXER_DIR, "config.yaml"), "utf8");
    expect(config).toContain(`  - id: ${d.chainId}\n    start_block: ${d.hunchBook.deployBlock}\n`);
    for (const key of ["factory", "vault", "router", "graduator", "usdc"]) {
      expect(config).toContain(`address: "${d.hunchBook[key]}"`);
    }
    // Template 7's resolver and every periphery contract, each under its own name.
    expect(config).toContain(
      `      - name: SnapshotResolver\n        address: "${d.hunchBook.resolvers.snapshot}"\n`,
    );
    for (const [name, key] of [
      ["AutoRedeemer", "autoRedeemer"],
      ["ConditionalOrders", "conditionalOrders"],
      ["ReferralRegistry", "referralRegistry"],
      ["MerkleDistributor", "merkleDistributor"],
      ["ImpliedProbabilityOracle", "impliedProbabilityOracle"],
      ["PriceAdapterFactory", "priceAdapterFactory"],
      ["TemplateTimelock", "templateTimelock"],
    ] as const) {
      expect(config).toContain(`      - name: ${name}\n        address: "${d.hunchBook.periphery[key]}"\n`);
    }
    expect(config).toContain(`url: \${ENVIO_MONAD_TESTNET_RPC:-${d.rpc}}`);
    expect(config).toContain(`for: \${ENVIO_RPC_MODE:-fallback}`);
    expect(config).toContain("interval_ceiling: 100");
  });

  it("leaves mainnet out until it has addresses, then renders it the same way", () => {
    const mainnet = deployment("monad-mainnet");
    const live = isDeployed(mainnet);
    expect(renderAll()["config.mainnet.yaml"] === null).toBe(!live);
    expect(existsSync(join(INDEXER_DIR, "config.mainnet.yaml"))).toBe(live);
    if (!live)
      expect(() => renderConfig(mainnet, "ENVIO_MONAD_MAINNET_RPC")).toThrow(/no Hunch Book addresses/);

    const deployed = {
      ...mainnet,
      hunchBook: {
        factory: "0x00000000000000000000000000000000000000f1",
        vault: "0x00000000000000000000000000000000000000f2",
        router: "0x00000000000000000000000000000000000000f3",
        graduator: "0x00000000000000000000000000000000000000f4",
        deployBlock: 123,
      },
    };
    const config = renderConfig(deployed, "ENVIO_MONAD_MAINNET_RPC");
    expect(config).toContain("name: hunch-book-mainnet");
    expect(config).toContain("  - id: 143\n    start_block: 123\n");
    expect(config).toContain(`url: \${ENVIO_MONAD_MAINNET_RPC:-${mainnet.rpc}}`);
    // Mainnet collateral is Circle USDC from the external block of the deployments file.
    expect(config).toContain(`address: "${mainnet.external.usdc}"`);
    // Contracts not deployed there yet are listed without an address, so they are never read.
    expect(config).toContain(
      "      - name: SnapshotResolver\n      - name: AutoRedeemer\n      - name: ConditionalOrders\n",
    );
    expect(config.trimEnd().endsWith("      - name: TemplateTimelock")).toBe(true);
    const withPeriphery = renderConfig(
      {
        ...deployed,
        hunchBook: {
          ...deployed.hunchBook,
          periphery: { autoRedeemer: "0x00000000000000000000000000000000000000f5" },
        },
      },
      "ENVIO_MONAD_MAINNET_RPC",
    );
    expect(withPeriphery).toContain(
      '      - name: AutoRedeemer\n        address: "0x00000000000000000000000000000000000000f5"\n',
    );
    // The core is required.
    expect(() =>
      renderConfig({ ...deployed, hunchBook: { ...deployed.hunchBook, router: undefined } }, "X"),
    ).toThrow(/no Hunch Book addresses/);
  });

  it("labels our wallets from the deployments file, lowercase", () => {
    for (const network of ["monad-testnet", "monad-mainnet"]) {
      const d = deployment(network);
      const n = networkConstants(d);
      expect(n.ours.maker).toBe(d.wallets.maker.toLowerCase());
      expect(n.ours.keeper).toBe(d.wallets.keeper.toLowerCase());
      expect(n.chainId).toBe(d.chainId);
    }
    const testnetFile = deployment("monad-testnet");
    const testnet = networkConstants(testnetFile);
    expect(testnet.perps["64"]).toBe("MON");
    expect(testnet.chainlinkFeeds["0x12c0f44368a02081ce58a936d1c1f606bb301715"]).toBe("BTC/USD");
    // The reward funder and the timelock proposer are ours too, and every address is lowercase.
    const p = testnetFile.hunchBook.periphery;
    expect(testnet.ours.distributorFunder).toBe(p.distributorFunder.toLowerCase());
    expect(testnet.ours.timelockProposer).toBe(p.timelockProposer.toLowerCase());
    expect(testnet.periphery).toEqual({
      autoRedeemer: p.autoRedeemer.toLowerCase(),
      conditionalOrders: p.conditionalOrders.toLowerCase(),
      referralRegistry: p.referralRegistry.toLowerCase(),
      merkleDistributor: p.merkleDistributor.toLowerCase(),
      impliedProbabilityOracle: p.impliedProbabilityOracle.toLowerCase(),
      priceAdapterFactory: p.priceAdapterFactory.toLowerCase(),
      templateTimelock: p.templateTimelock.toLowerCase(),
      deployBlock: p.deployBlock,
    });
    expect(testnet.resolvers.snapshot).toBe(testnetFile.hunchBook.resolvers.snapshot.toLowerCase());
    const mainnet = networkConstants(deployment("monad-mainnet"));
    expect(mainnet.periphery.autoRedeemer).toBeNull();
    expect(mainnet.resolvers).toEqual({});
  });

  it("reads every stack: one address per stack, the primary first, and each stack's constants", () => {
    const testnet = deployment("monad-testnet");
    const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const v2 = {
      factory: a(0xf1),
      vault: a(0xf2),
      router: a(0xf3),
      graduator: a(0xf4),
      usdc: testnet.hunchBook.usdc,
      kuruVersion: 2,
      guardian: a(0xf5),
      resolvers: { priceAtTime: a(0xf6) },
      periphery: {
        conditionalOrders: a(0xf7),
        priceAdapterFactory: a(0xf8),
        kuruFeedFactory: a(0xf9),
        distributorFunder: a(0xfa),
      },
      deployBlock: testnet.hunchBook.deployBlock + 1_000,
    };
    const both = { ...testnet, stacks: { kuruV2: v2, halfDone: { factory: a(0xfb) } } };

    // A stack counts once its core is deployed.
    expect(stacksOf(both).map((s) => s.name)).toEqual(["primary", "kuruV2"]);
    const statics = staticContracts(both);
    expect(statics.HunchBookFactory).toEqual([testnet.hunchBook.factory, v2.factory]);
    expect(statics.Graduator).toEqual([testnet.hunchBook.graduator, v2.graduator]);
    // The stacks share the collateral token: listed once.
    expect(statics.Usdc).toEqual([testnet.hunchBook.usdc]);
    // Both kinds of adapter factory, and a contract only the primary stack has.
    expect(statics.PriceAdapterFactory).toEqual([
      testnet.hunchBook.periphery.priceAdapterFactory,
      v2.periphery.priceAdapterFactory,
      v2.periphery.kuruFeedFactory,
    ]);
    expect(statics.AutoRedeemer).toEqual([testnet.hunchBook.periphery.autoRedeemer]);

    const config = renderConfig(both, "ENVIO_MONAD_TESTNET_RPC");
    expect(config).toContain(
      `      - name: HunchBookFactory\n        address:\n          - "${testnet.hunchBook.factory}"\n          - "${v2.factory}"\n`,
    );
    expect(config).toContain(`      - name: Usdc\n        address: "${testnet.hunchBook.usdc}"\n`);
    // Kuru v2 books are a dynamic contract of their own, read for SpotSwap.
    expect(config).toContain("      - name: KuruSpotBook\n");
    expect(config).toMatch(
      /- name: KuruSpotBook\n {4}events:\n {6}- event: SpotSwap\(uint40 userId, address executor, bool isBuy/,
    );
    // Still read from the primary deploy block.
    expect(config).toContain(`start_block: ${testnet.hunchBook.deployBlock}\n`);

    const n = networkConstants(both);
    expect(n.stacks.map((s) => [s.name, s.primary, s.kuruVersion])).toEqual([
      ["primary", true, 1],
      ["kuruV2", false, 2],
    ]);
    expect(n.stacks[1]).toMatchObject({
      factory: v2.factory,
      graduator: v2.graduator,
      guardian: v2.guardian,
      resolvers: { priceAtTime: v2.resolvers.priceAtTime },
      periphery: { kuruFeedFactory: v2.periphery.kuruFeedFactory, autoRedeemer: null },
    });
    // The primary stack's constants stay where the handlers have always read them.
    expect(n.contracts.factory).toBe(testnet.hunchBook.factory.toLowerCase());
    expect(n.kuruV2?.spotRouter).toBe(testnet.external.kuruV2.spotRouter.toLowerCase());
    // A network that is not deployed lists no stacks.
    expect(networkConstants(deployment("monad-mainnet")).stacks).toEqual([]);
  });

  it("writes event signatures Envio can read, from the contracts' ABIs", () => {
    expect(
      eventSignature(
        [
          {
            type: "event",
            name: "TemplateAdded",
            inputs: [
              { name: "templateId", type: "uint32", indexed: true },
              {
                name: "rule",
                type: "tuple",
                indexed: false,
                components: [
                  { name: "minPool", type: "uint128" },
                  { name: "minStakers", type: "uint32" },
                ],
              },
              { name: "ids", type: "uint40[]", indexed: false },
            ],
          },
        ],
        "TemplateAdded",
      ),
    ).toBe(
      "TemplateAdded(uint32 indexed templateId, (uint128 minPool, uint32 minStakers) rule, uint40[] ids)",
    );
    expect(() => eventSignature([], "Missing")).toThrow(/expected one event Missing/);
  });

  it("has a handler for every configured event, and configures every handled event", () => {
    const handlerDir = join(INDEXER_DIR, "src", "handlers");
    const source = readdirSync(handlerDir)
      .map((f) => readFileSync(join(handlerDir, f), "utf8"))
      .join("\n");
    const handled = new Set(
      [...source.matchAll(/onEvent\(\s*\{\s*contract: "(\w+)",\s*event: "(\w+)"/g)].map(
        (m) => `${m[1]}.${m[2]}`,
      ),
    );
    const configured = new Set(
      contractEvents().flatMap((c) => c.events.map((e) => `${c.name}.${e.slice(0, e.indexOf("("))}`)),
    );
    expect([...handled].sort()).toEqual([...configured].sort());
    // Dynamic contracts are registered from these events.
    for (const [contract, event, target] of [
      ["HunchBookFactory", "MarketCreated", "Market"],
      ["CollateralVault", "MarketRegistered", "Market"],
      ["CollateralVault", "MarketRegistered", "OutcomeToken"],
      ["Graduator", "BookCreated", "KuruOrderBook"],
      ["Graduator", "BookRegistered", "KuruOrderBook"],
      // A Kuru v2 stack's graduator registers its books as KuruSpotBook.
      ["Graduator", "BookCreated", "KuruSpotBook"],
      ["Graduator", "BookRegistered", "KuruSpotBook"],
    ]) {
      const register = new RegExp(
        `contractRegister\\(\\s*\\{\\s*contract: "${contract}",\\s*event: "${event}"\\s*\\}[^]*?context\\.chain\\.${target}\\.add`,
      );
      expect(source).toMatch(register);
    }
  });
});
