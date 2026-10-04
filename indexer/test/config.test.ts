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
  staleFiles,
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
    ]) {
      const register = new RegExp(
        `contractRegister\\(\\s*\\{\\s*contract: "${contract}",\\s*event: "${event}"\\s*\\}[^]*?context\\.chain\\.${target}\\.add`,
      );
      expect(source).toMatch(register);
    }
  });
});
