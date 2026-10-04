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
  });

  it("labels our wallets from the deployments file, lowercase", () => {
    for (const network of ["monad-testnet", "monad-mainnet"]) {
      const d = deployment(network);
      const n = networkConstants(d);
      expect(n.ours.maker).toBe(d.wallets.maker.toLowerCase());
      expect(n.ours.keeper).toBe(d.wallets.keeper.toLowerCase());
      expect(n.chainId).toBe(d.chainId);
    }
    const testnet = networkConstants(deployment("monad-testnet"));
    expect(testnet.perps["64"]).toBe("MON");
    expect(testnet.chainlinkFeeds["0x12c0f44368a02081ce58a936d1c1f606bb301715"]).toBe("BTC/USD");
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
