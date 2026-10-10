// Writes the indexer's network files from deployments/<network>.json, the only source of addresses:
//   config.yaml                  Envio config for Monad testnet
//   config.mainnet.yaml          Envio config for Monad mainnet, only once mainnet has Hunch Book addresses
//   src/networks.generated.json  per-chain constants the handlers read (our wallets, contracts, labels)
// Event signatures come from the ABIs in packages/shared (generated from the contracts), so the
// config cannot drift from the contracts either.
//
//   pnpm --filter @hunch-book/indexer gen-config          write the files
//   pnpm --filter @hunch-book/indexer gen-config --check  fail if a committed file is stale
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoRedeemerAbi,
  collateralVaultAbi,
  conditionalOrdersAbi,
  graduatorAbi,
  hunchBookFactoryAbi,
  hunchRouterAbi,
  impliedProbabilityOracleAbi,
  marketAbi,
  merkleDistributorAbi,
  outcomeTokenPriceAdapterFactoryAbi,
  referralRegistryAbi,
  snapshotResolverAbi,
  templateTimelockAbi,
} from "../../packages/shared/src/abis/generated.js";
import { kuruOrderBookAbi } from "../../packages/shared/src/kuru/abis.js";
import { kuruV2OrderBookAbi } from "../../packages/shared/src/kuru/v2abis.js";
import type { NetworkConstants, StackConstants } from "../src/lib/network.js";

export const INDEXER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(INDEXER_DIR, "..");

/** The two networks, in the order they appear in the generated files. */
export const NETWORKS = [
  { network: "monad-testnet", file: "config.yaml", rpcEnv: "ENVIO_MONAD_TESTNET_RPC" },
  { network: "monad-mainnet", file: "config.mainnet.yaml", rpcEnv: "ENVIO_MONAD_MAINNET_RPC" },
] as const;

export const NETWORKS_JSON = "src/networks.generated.json";

/** Public Monad RPCs answer eth_getLogs for at most 100 blocks per request. */
export const RPC_BLOCK_RANGE = 100;

/** One stack of Hunch Book contracts: `hunchBook` (the primary one) or an entry under `stacks`. */
interface StackSection {
  factory?: string;
  vault?: string;
  router?: string;
  graduator?: string;
  usdc?: string;
  marketImplementation?: string;
  guardian?: string;
  feeRecipient?: string;
  deployBlock?: number;
  /** 1 when absent (the primary testnet stack predates the field). */
  kuruVersion?: number;
  /**
   * Set when the stack's books are on Hunch Book's own order book (contracts/src/venue/) instead of
   * Kuru's. Those books speak Kuru v1's interface, so `kuruVersion` is 1.
   */
  venue?: { kind: string; bookFactory?: string; marginAccount?: string; bookImplementation?: string };
  resolvers?: Record<string, string>;
  periphery?: {
    autoRedeemer?: string;
    conditionalOrders?: string;
    referralRegistry?: string;
    merkleDistributor?: string;
    impliedProbabilityOracle?: string;
    priceAdapterFactory?: string;
    kuruFeedFactory?: string;
    templateTimelock?: string;
    timelockProposer?: string;
    distributorFunder?: string;
    deployBlock?: number;
  };
}

interface DeploymentFile {
  network: string;
  chainId: number;
  rpc: string;
  explorer: string;
  hunchBook: StackSection;
  /** Extra stacks by name (testnet: `kuruV2` and `hunch`, next to the Kuru v1 primary stack). */
  stacks?: Record<string, StackSection>;
  wallets: { maker: string; keeper: string };
  external: {
    usdc?: string;
    kuru: { router: string; marginAccount: string };
    kuruV2?: { accountCore: string; spotRouter: string };
    perpl: { exchange: string; perps: Record<string, number> };
    chainlink: Record<string, string>;
    pyth: { contract: string; ids: Record<string, string> };
  };
}

/** A stack with its name: "primary" for `hunchBook`, else its key under `stacks`. */
interface NamedStack {
  name: string;
  primary: boolean;
  s: StackSection;
}

/**
 * Every stack the indexer reads, the primary first. An extra stack counts once its core is deployed
 * (factory, vault, router and graduator); until then it is left out, as a network is before its deploy.
 */
export function stacksOf(d: DeploymentFile): NamedStack[] {
  const out: NamedStack[] = [{ name: "primary", primary: true, s: d.hunchBook }];
  for (const [name, s] of Object.entries(d.stacks ?? {})) {
    if (s.factory && s.vault && s.router && s.graduator) out.push({ name, primary: false, s });
  }
  return out;
}

// ---- events -------------------------------------------------------------------------------

type AbiParam = { name: string; type: string; indexed?: boolean; components?: readonly AbiParam[] };
type AbiItem = { type: string; name?: string; inputs?: readonly AbiParam[] };

function paramType(p: AbiParam): string {
  if (p.type.startsWith("tuple")) {
    const inner = (p.components ?? []).map((c) => `${paramType(c)} ${c.name}`).join(", ");
    return `(${inner})${p.type.slice("tuple".length)}`;
  }
  return p.type;
}

/** "Staked(address indexed user, uint8 side, ...)", the human-readable form Envio's config takes. */
export function eventSignature(abi: readonly AbiItem[], name: string): string {
  const matches = abi.filter((item) => item.type === "event" && item.name === name);
  if (matches.length !== 1) throw new Error(`expected one event ${name} in the ABI, found ${matches.length}`);
  const inputs = (matches[0]?.inputs ?? []).map((p) => {
    if (!p.name) throw new Error(`event ${name} has an unnamed input`);
    return `${paramType(p)}${p.indexed ? " indexed" : ""} ${p.name}`;
  });
  return `${name}(${inputs.join(", ")})`;
}

const ERC20_TRANSFER = "Transfer(address indexed from, address indexed to, uint256 value)";

/** Every contract the indexer reads, with the events it handles. Static ones have an address per chain. */
export function contractEvents(): { name: string; dynamic: boolean; events: string[] }[] {
  const pick = (abi: readonly AbiItem[], names: string[]) => names.map((n) => eventSignature(abi, n));
  return [
    {
      name: "HunchBookFactory",
      dynamic: false,
      events: pick(hunchBookFactoryAbi, ["MarketCreated", "TemplateAdded"]),
    },
    {
      name: "CollateralVault",
      dynamic: false,
      events: pick(collateralVaultAbi, [
        "MarketRegistered",
        "PoolDeposited",
        "PoolGraduated",
        "PoolPaid",
        "SetsMinted",
        "SetsMerged",
        "Finalized",
        "MarketVoided",
        "Redeemed",
        "FeesAccrued",
        "ProtocolFeesWithdrawn",
        "CreatorFeesWithdrawn",
        "FlashLoan",
      ]),
    },
    { name: "HunchRouter", dynamic: false, events: pick(hunchRouterAbi, ["Trade"]) },
    { name: "Graduator", dynamic: false, events: pick(graduatorAbi, ["BookCreated", "BookRegistered"]) },
    // The collateral token, read only for transfers into and out of the vault (filtered in the handler).
    { name: "Usdc", dynamic: false, events: [ERC20_TRANSFER] },
    {
      name: "Market",
      dynamic: true,
      events: pick(marketAbi, [
        "Staked",
        "Graduated",
        "TokensClaimed",
        "Settled",
        "Voided",
        "PoolClaimed",
        "DustSwept",
      ]),
    },
    { name: "OutcomeToken", dynamic: true, events: [ERC20_TRANSFER] },
    // Kuru v1 books (the primary testnet stack), and Hunch Book's own books (a stack with a Hunch
    // venue), which emit Kuru v1's events with the same layouts: every fill names its maker.
    {
      name: "KuruOrderBook",
      dynamic: true,
      events: pick(kuruOrderBookAbi as unknown as readonly AbiItem[], [
        "Trade",
        "OrderCreated",
        "OrderCanceled",
        "OrdersCanceled",
      ]),
    },
    // Kuru v2 books (docs/PROTOCOL.md section 8.1): one SpotSwap per taker swap, without its makers.
    {
      name: "KuruSpotBook",
      dynamic: true,
      events: pick(kuruV2OrderBookAbi as unknown as readonly AbiItem[], ["SpotSwap"]),
    },
    // Template 7's resolver keeps the snapshots it takes.
    { name: "SnapshotResolver", dynamic: false, events: pick(snapshotResolverAbi, ["SnapshotTaken"]) },
    // Periphery (docs/PERIPHERY.md).
    {
      name: "AutoRedeemer",
      dynamic: false,
      events: pick(autoRedeemerAbi, ["OptInSet", "MarketOptOutSet", "AutoRedeemed", "RedeemFailed"]),
    },
    {
      name: "ConditionalOrders",
      dynamic: false,
      events: pick(conditionalOrdersAbi, ["OrderPlaced", "OrderCancelled", "OrderExecuted"]),
    },
    { name: "ReferralRegistry", dynamic: false, events: pick(referralRegistryAbi, ["Bound"]) },
    {
      name: "MerkleDistributor",
      dynamic: false,
      events: pick(merkleDistributorAbi, [
        "EpochCreated",
        "Claimed",
        "Swept",
        "FunderTransferStarted",
        "FunderTransferred",
      ]),
    },
    {
      name: "ImpliedProbabilityOracle",
      dynamic: false,
      events: pick(impliedProbabilityOracleAbi, ["Poked"]),
    },
    {
      name: "PriceAdapterFactory",
      dynamic: false,
      events: pick(outcomeTokenPriceAdapterFactoryAbi, ["AdapterCreated"]),
    },
    {
      name: "TemplateTimelock",
      dynamic: false,
      events: pick(templateTimelockAbi, [
        "OperationQueued",
        "OperationExecuted",
        "OperationCancelled",
        "CreationPauseSet",
        "GraduationPauseSet",
        "GuardianAccepted",
      ]),
    },
  ];
}

/** The core contracts a network needs before it gets a config at all. */
export const CORE_CONTRACTS = ["HunchBookFactory", "CollateralVault", "HunchRouter", "Graduator", "Usdc"];

/**
 * Where each static contract is on a network: one address per stack that has it, the primary stack's
 * first, without repeats (the stacks share the collateral token). A contract the deployments file has
 * no address for gets an empty list, so nothing registers it and it is never read there (the same
 * handlers serve every network). Every static contract is read from the primary deploy block,
 * including those deployed later (another stack, template 7's resolver, the periphery): they have no
 * logs before their deployment, and Envio 3.12 cannot resume a test indexer past a contract start
 * block later than the chain's.
 */
export function staticContracts(d: DeploymentFile): Record<string, string[]> {
  const stacks = stacksOf(d);
  const each = (pick: (s: StackSection) => string | undefined): string[] => {
    const out: string[] = [];
    for (const { s } of stacks) {
      const a = pick(s);
      if (a && !out.some((b) => b.toLowerCase() === a.toLowerCase())) out.push(a);
    }
    return out;
  };
  return {
    HunchBookFactory: each((s) => s.factory),
    CollateralVault: each((s) => s.vault),
    HunchRouter: each((s) => s.router),
    Graduator: each((s) => s.graduator),
    Usdc: each((s) => s.usdc ?? collateralOf(d)),
    SnapshotResolver: each((s) => s.resolvers?.snapshot),
    AutoRedeemer: each((s) => s.periphery?.autoRedeemer),
    ConditionalOrders: each((s) => s.periphery?.conditionalOrders),
    ReferralRegistry: each((s) => s.periphery?.referralRegistry),
    MerkleDistributor: each((s) => s.periphery?.merkleDistributor),
    ImpliedProbabilityOracle: each((s) => s.periphery?.impliedProbabilityOracle),
    // Both kinds of adapter factory emit AdapterCreated: the lending one and, on a Kuru v2 stack, the
    // one whose adapters are Kuru's price feeds for YES and NO (oracle.ts tells them apart).
    PriceAdapterFactory: [
      ...each((s) => s.periphery?.priceAdapterFactory),
      ...each((s) => s.periphery?.kuruFeedFactory),
    ],
    TemplateTimelock: each((s) => s.periphery?.templateTimelock),
  };
}

// ---- rendering ----------------------------------------------------------------------------

/** Envio's environment-variable reference with a default, resolved when the indexer starts. */
export function envRef(name: string, fallback: string): string {
  return `\${${name}:-${fallback}}`;
}

function readDeployment(network: string): DeploymentFile {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "deployments", `${network}.json`), "utf8"),
  ) as DeploymentFile;
}

const lower = (a: string | undefined): string | null => (a ? a.toLowerCase() : null);

/**
 * Where a stack's books are, in Kuru v1's terms, as packages/shared's deploymentForStack sees them: a
 * Kuru stack keeps Kuru's Router and MarginAccount from `external.kuru`; a stack with a Hunch venue gets
 * its own HunchOrderBookFactory (in the Router's place: it emits the Router's MarketRegistered) and
 * HunchMarginAccount, and nothing of Kuru's.
 */
export function bookVenueOf(d: DeploymentFile, s: StackSection): Pick<StackConstants, "venue" | "kuru"> {
  if (s.venue?.kind !== "hunch") {
    return {
      venue: "kuru",
      kuru: {
        router: d.external.kuru.router.toLowerCase(),
        marginAccount: d.external.kuru.marginAccount.toLowerCase(),
      },
    };
  }
  const { bookFactory, marginAccount } = s.venue;
  if (!bookFactory || !marginAccount) {
    throw new Error(`${d.network}: a Hunch venue needs venue.bookFactory and venue.marginAccount`);
  }
  return {
    venue: "hunch",
    kuru: { router: bookFactory.toLowerCase(), marginAccount: marginAccount.toLowerCase() },
  };
}

export function collateralOf(d: DeploymentFile): string | undefined {
  return d.hunchBook.usdc ?? d.external.usdc;
}

/** A network gets an indexer config once every core contract the indexer reads has an address. */
export function isDeployed(d: DeploymentFile): boolean {
  const h = d.hunchBook;
  return Boolean(h.factory && h.vault && h.router && h.graduator && collateralOf(d) && h.deployBlock);
}

/** One stack's constants, addresses lowercase. */
export function stackConstants(d: DeploymentFile, stack: NamedStack): StackConstants {
  const { s } = stack;
  const p = s.periphery ?? {};
  return {
    name: stack.name,
    primary: stack.primary,
    kuruVersion: s.kuruVersion === 2 ? 2 : 1,
    ...bookVenueOf(d, s),
    factory: lower(s.factory),
    vault: lower(s.vault),
    router: lower(s.router),
    graduator: lower(s.graduator),
    guardian: lower(s.guardian),
    feeRecipient: lower(s.feeRecipient),
    resolvers: Object.fromEntries(
      Object.entries(s.resolvers ?? {}).map(([name, address]) => [name, address.toLowerCase()]),
    ),
    periphery: {
      autoRedeemer: lower(p.autoRedeemer),
      conditionalOrders: lower(p.conditionalOrders),
      referralRegistry: lower(p.referralRegistry),
      merkleDistributor: lower(p.merkleDistributor),
      impliedProbabilityOracle: lower(p.impliedProbabilityOracle),
      priceAdapterFactory: lower(p.priceAdapterFactory),
      kuruFeedFactory: lower(p.kuruFeedFactory),
      templateTimelock: lower(p.templateTimelock),
      distributorFunder: lower(p.distributorFunder),
      timelockProposer: lower(p.timelockProposer),
    },
  };
}

export function networkConstants(d: DeploymentFile): NetworkConstants {
  const h = d.hunchBook;
  const p = h.periphery ?? {};
  const invert = (m: Record<string, string | number>, lowerKeys: boolean) =>
    Object.fromEntries(
      Object.entries(m).map(([label, value]) => [
        lowerKeys ? String(value).toLowerCase() : String(value),
        label,
      ]),
    );
  return {
    chainId: d.chainId,
    network: d.network,
    explorer: d.explorer,
    deployed: isDeployed(d),
    deployBlock: h.deployBlock ?? null,
    contracts: {
      factory: lower(h.factory),
      vault: lower(h.vault),
      router: lower(h.router),
      graduator: lower(h.graduator),
      usdc: lower(collateralOf(d)),
      marketImplementation: lower(h.marketImplementation),
    },
    resolvers: Object.fromEntries(
      Object.entries(h.resolvers ?? {}).map(([name, address]) => [name, address.toLowerCase()]),
    ),
    periphery: {
      autoRedeemer: lower(p.autoRedeemer),
      conditionalOrders: lower(p.conditionalOrders),
      referralRegistry: lower(p.referralRegistry),
      merkleDistributor: lower(p.merkleDistributor),
      impliedProbabilityOracle: lower(p.impliedProbabilityOracle),
      priceAdapterFactory: lower(p.priceAdapterFactory),
      templateTimelock: lower(p.templateTimelock),
      deployBlock: p.deployBlock ?? null,
    },
    ours: {
      maker: d.wallets.maker.toLowerCase(),
      keeper: d.wallets.keeper.toLowerCase(),
      guardian: lower(h.guardian),
      feeRecipient: lower(h.feeRecipient),
      distributorFunder: lower(p.distributorFunder),
      timelockProposer: lower(p.timelockProposer),
    },
    // The primary stack's, like `contracts` above: every other stack has its own in `stacks`.
    kuru: bookVenueOf(d, h).kuru,
    kuruV2: d.external.kuruV2
      ? {
          accountCore: d.external.kuruV2.accountCore.toLowerCase(),
          spotRouter: d.external.kuruV2.spotRouter.toLowerCase(),
        }
      : null,
    stacks: isDeployed(d) ? stacksOf(d).map((stack) => stackConstants(d, stack)) : [],
    perps: invert(d.external.perpl.perps, false),
    chainlinkFeeds: invert(d.external.chainlink, true),
    pythIds: invert(d.external.pyth.ids, true),
  };
}

export function renderConfig(d: DeploymentFile, rpcEnv: string): string {
  const h = d.hunchBook;
  if (!isDeployed(d)) throw new Error(`${d.network} has no Hunch Book addresses yet`);
  const contracts = contractEvents();
  const addresses = staticContracts(d);
  const lines = [
    `# Generated by scripts/gen-config.ts from deployments/${d.network}.json. Do not edit by hand.`,
    "# Regenerate: pnpm --filter @hunch-book/indexer gen-config",
    "# yaml-language-server: $schema=./node_modules/envio/evm.schema.json",
    `name: hunch-book-${d.network.replace(/^monad-/, "")}`,
    `description: Hunch Book on ${d.network === "monad-mainnet" ? "Monad mainnet" : "Monad testnet"}, chain ${d.chainId}`,
    "schema: ./schema.graphql",
    "handlers: ./src/handlers",
    "address_format: lowercase",
    "field_selection:",
    "  transaction_fields:",
    "    - hash",
    "    - from",
    "contracts:",
  ];
  for (const c of contracts) {
    lines.push(`  - name: ${c.name}`, "    events:");
    for (const e of c.events) lines.push(`      - event: ${e}`);
  }
  lines.push(
    "chains:",
    `  - id: ${d.chainId}`,
    `    start_block: ${h.deployBlock}`,
    "    # HyperSync is the main source and needs ENVIO_API_TOKEN. Without a token, set ENVIO_RPC_MODE=sync",
    "    # (the dev and start scripts do this for you) and the indexer reads logs from this RPC instead.",
    "    rpc:",
    `      - url: ${envRef(rpcEnv, d.rpc)}`,
    `        for: ${envRef("ENVIO_RPC_MODE", "fallback")}`,
    `        initial_block_interval: ${RPC_BLOCK_RANGE}`,
    `        interval_ceiling: ${RPC_BLOCK_RANGE}`,
    "    # Contracts without an address are registered while indexing (markets, tokens, books), or are",
    "    # not deployed on this network yet and are never read.",
    "    contracts:",
  );
  for (const c of contracts) {
    lines.push(`      - name: ${c.name}`);
    if (c.dynamic) continue;
    if (!(c.name in addresses)) throw new Error(`static contract ${c.name} has no entry in staticContracts`);
    const list = addresses[c.name] ?? [];
    if (list.length === 1) lines.push(`        address: "${list[0]}"`);
    else if (list.length > 1) {
      // One address per stack (docs/PROTOCOL.md section 8.1): the same handlers read every stack.
      lines.push("        address:");
      for (const a of list) lines.push(`          - "${a}"`);
    } else if (CORE_CONTRACTS.includes(c.name)) throw new Error(`no address for ${c.name} on ${d.network}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Every generated file, by path relative to the indexer directory. `null` means the file must not exist. */
export function renderAll(): Record<string, string | null> {
  const files: Record<string, string | null> = {};
  const constants: Record<string, NetworkConstants> = {};
  for (const n of NETWORKS) {
    const d = readDeployment(n.network);
    if (d.network !== n.network) throw new Error(`deployments/${n.network}.json names itself ${d.network}`);
    constants[String(d.chainId)] = networkConstants(d);
    files[n.file] = isDeployed(d) ? renderConfig(d, n.rpcEnv) : null;
  }
  files[NETWORKS_JSON] = `${JSON.stringify(constants, null, 2)}\n`;
  return files;
}

/** Paths whose committed content differs from what the deployments files produce. */
export function staleFiles(files = renderAll()): string[] {
  return Object.entries(files)
    .filter(([path, content]) => {
      const full = join(INDEXER_DIR, path);
      if (content === null) return existsSync(full);
      return !existsSync(full) || readFileSync(full, "utf8") !== content;
    })
    .map(([path]) => path);
}

function main(): void {
  const files = renderAll();
  if (process.argv.includes("--check")) {
    const stale = staleFiles(files);
    if (stale.length > 0) {
      console.error(`stale: ${stale.join(", ")}. Run: pnpm --filter @hunch-book/indexer gen-config`);
      process.exit(1);
    }
    console.log("indexer config matches deployments/");
    return;
  }
  for (const [path, content] of Object.entries(files)) {
    const full = join(INDEXER_DIR, path);
    if (content === null) {
      if (existsSync(full)) rmSync(full);
      continue;
    }
    writeFileSync(full, content);
    console.log(`wrote indexer/${path}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
