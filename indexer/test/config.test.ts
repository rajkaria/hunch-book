// The generated config and network files cannot drift from deployments/ or from the handlers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bookVenueOf,
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

/** Each address once, the first spelling kept: stacks can share a contract (testnet: the resolvers). */
const distinct = (all: string[]): string[] =>
  all.filter((a, i) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);

/** The addresses a contract has in a rendered config's chain section, in order (one line or a list). */
function addressesOf(config: string, name: string): string[] {
  const chain = config.slice(config.indexOf("\nchains:"));
  const at = chain.indexOf(`      - name: ${name}\n`);
  if (at < 0) return [];
  const lines = chain.slice(at).split("\n").slice(1);
  const first = lines[0] ?? "";
  const single = first.match(/^ {8}address: "(0x[0-9a-fA-F]{40})"$/);
  if (single?.[1]) return [single[1]];
  if (first !== "        address:") return [];
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^ {10}- "(0x[0-9a-fA-F]{40})"$/);
    if (!m?.[1]) break;
    out.push(m[1]);
  }
  return out;
}

describe("generated config", () => {
  it("is up to date with deployments/ (run gen-config if this fails)", () => {
    expect(staleFiles()).toEqual([]);
  });

  it("indexes testnet from the deploy block with every static address from the deployments file", () => {
    const d = deployment("monad-testnet");
    const config = readFileSync(join(INDEXER_DIR, "config.yaml"), "utf8");
    expect(config).toContain(`  - id: ${d.chainId}\n    start_block: ${d.hunchBook.deployBlock}\n`);
    const extra = Object.values(d.stacks ?? {}) as (typeof d.hunchBook)[];
    for (const [name, key] of [
      ["HunchBookFactory", "factory"],
      ["CollateralVault", "vault"],
      ["HunchRouter", "router"],
      ["Graduator", "graduator"],
    ] as const) {
      // The primary stack's address first, then each extra stack's.
      expect(addressesOf(config, name)).toEqual([d.hunchBook[key], ...extra.map((s) => s[key])]);
    }
    expect(addressesOf(config, "Usdc")).toEqual([d.hunchBook.usdc]);
    // Template 7's resolver and every periphery contract, each under its own name, on every stack,
    // once each (the `hunch` stack shares the primary stack's snapshot resolver).
    expect(addressesOf(config, "SnapshotResolver")).toEqual(
      distinct([d.hunchBook, ...extra].flatMap((s) => (s.resolvers?.snapshot ? [s.resolvers.snapshot] : []))),
    );
    for (const [name, key] of [
      ["AutoRedeemer", "autoRedeemer"],
      ["ConditionalOrders", "conditionalOrders"],
      ["ReferralRegistry", "referralRegistry"],
      ["MerkleDistributor", "merkleDistributor"],
      ["ImpliedProbabilityOracle", "impliedProbabilityOracle"],
      ["TemplateTimelock", "templateTimelock"],
    ] as const) {
      const all = [d.hunchBook, ...extra].flatMap((s) => (s.periphery?.[key] ? [s.periphery[key]] : []));
      expect(addressesOf(config, name)).toEqual(distinct(all));
    }
    // Lending adapter factories, then Kuru v2 feed factories.
    const stacks = [d.hunchBook, ...extra];
    expect(addressesOf(config, "PriceAdapterFactory")).toEqual([
      ...stacks.flatMap((s) => (s.periphery?.priceAdapterFactory ? [s.periphery.priceAdapterFactory] : [])),
      ...stacks.flatMap((s) => (s.periphery?.kuruFeedFactory ? [s.periphery.kuruFeedFactory] : [])),
    ]);
    expect(config).toContain(`url: \${ENVIO_MONAD_TESTNET_RPC:-${d.rpc}}`);
    expect(config).toContain(`for: \${ENVIO_RPC_MODE:-fallback}`);
    expect(config).toContain("interval_ceiling: 100");
    // Books are found from each graduator's events, never by reading Kuru's contracts or a venue's.
    const venues = extra.flatMap((s) => (s.venue ? [s.venue.bookFactory, s.venue.marginAccount] : []));
    for (const a of [d.external.kuru.router, d.external.kuru.marginAccount, ...venues]) {
      expect(config.toLowerCase()).not.toContain(a.toLowerCase());
    }
  });

  it("gives each testnet stack its own book venue: Kuru's, or its own order book's, never both", () => {
    const d = deployment("monad-testnet");
    const n = networkConstants(d);
    const kuru = {
      router: d.external.kuru.router.toLowerCase(),
      marginAccount: d.external.kuru.marginAccount.toLowerCase(),
    };
    // Every stack in the deployments file, the primary first, each with its venue.
    expect(n.stacks.map((s) => s.name)).toEqual(["primary", ...Object.keys(d.stacks ?? {})]);
    for (const s of n.stacks) {
      const section = s.primary ? d.hunchBook : d.stacks[s.name];
      if (section.venue?.kind === "hunch") {
        expect(s).toMatchObject({
          venue: "hunch",
          kuruVersion: 1,
          kuru: {
            router: section.venue.bookFactory.toLowerCase(),
            marginAccount: section.venue.marginAccount.toLowerCase(),
          },
        });
        expect(s.kuru.router).not.toBe(kuru.router);
        expect(s.kuru.marginAccount).not.toBe(kuru.marginAccount);
      } else {
        expect(s.venue).toBe("kuru");
        expect(s.kuru).toEqual(kuru);
      }
    }
    // The testnet `hunch` stack is the one on Hunch Book's own order book.
    const hunch = n.stacks.find((s) => s.name === "hunch");
    if (d.stacks?.hunch) expect(hunch?.venue).toBe("hunch");
    // The top-level `kuru` is the primary stack's, like `contracts`.
    expect(n.kuru).toEqual(n.stacks[0]?.kuru);
  });

  it("reads a Hunch venue's book factory and margin account in Kuru's place, wherever the stack is", () => {
    const testnet = deployment("monad-testnet");
    const a = (k: number) => `0x${k.toString(16).padStart(40, "0")}`;
    const venue = {
      kind: "hunch",
      bookFactory: a(0xe1),
      marginAccount: a(0xe2),
      bookImplementation: a(0xe3),
    };
    expect(bookVenueOf(testnet, { venue })).toEqual({
      venue: "hunch",
      kuru: { router: a(0xe1), marginAccount: a(0xe2) },
    });
    // No venue, or one of another kind, is Kuru (as packages/shared's venueOf reads it).
    const kuru = {
      venue: "kuru",
      kuru: {
        router: testnet.external.kuru.router.toLowerCase(),
        marginAccount: testnet.external.kuru.marginAccount.toLowerCase(),
      },
    };
    expect(bookVenueOf(testnet, {})).toEqual(kuru);
    expect(bookVenueOf(testnet, { venue: { kind: "other", bookFactory: a(0xe1) } })).toEqual(kuru);
    // A Hunch venue without its contracts is a broken deployments file.
    expect(() => bookVenueOf(testnet, { venue: { kind: "hunch", bookFactory: a(0xe1) } })).toThrow(
      /venue.bookFactory and venue.marginAccount/,
    );

    // A primary stack on a Hunch venue (Deploy.s.sol with VENUE=hunch): the top-level `kuru` is its own.
    const mainnet = deployment("monad-mainnet");
    const deployed = {
      ...mainnet,
      hunchBook: {
        factory: a(0xf1),
        vault: a(0xf2),
        router: a(0xf3),
        graduator: a(0xf4),
        deployBlock: 123,
        venue,
      },
    };
    const n = networkConstants(deployed);
    expect(n.kuru).toEqual({ router: a(0xe1), marginAccount: a(0xe2) });
    expect(n.stacks).toHaveLength(1);
    expect(n.stacks[0]).toMatchObject({ name: "primary", venue: "hunch", kuruVersion: 1 });
    // Its books are still found from its graduator; nothing of Kuru's is read.
    const config = renderConfig(deployed, "ENVIO_MONAD_MAINNET_RPC");
    expect(config).toContain(`      - name: Graduator\n        address: "${a(0xf4)}"\n`);
    for (const k of [mainnet.external.kuru.router, mainnet.external.kuru.marginAccount, a(0xe1), a(0xe2)]) {
      expect(config.toLowerCase()).not.toContain(k.toLowerCase());
    }
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
    expect(n.stacks.map((s) => [s.name, s.primary, s.kuruVersion, s.venue])).toEqual([
      ["primary", true, 1, "kuru"],
      ["kuruV2", false, 2, "kuru"],
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
