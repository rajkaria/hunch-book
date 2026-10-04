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
  collateralVaultAbi,
  graduatorAbi,
  hunchBookFactoryAbi,
  hunchRouterAbi,
  marketAbi,
} from "../../packages/shared/src/abis/generated.js";
import { kuruOrderBookAbi } from "../../packages/shared/src/kuru/abis.js";
import type { NetworkConstants } from "../src/lib/network.js";

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

interface DeploymentFile {
  network: string;
  chainId: number;
  rpc: string;
  explorer: string;
  hunchBook: {
    factory?: string;
    vault?: string;
    router?: string;
    graduator?: string;
    usdc?: string;
    marketImplementation?: string;
    guardian?: string;
    feeRecipient?: string;
    deployBlock?: number;
  };
  wallets: { maker: string; keeper: string };
  external: {
    usdc?: string;
    kuru: { router: string; marginAccount: string };
    perpl: { exchange: string; perps: Record<string, number> };
    chainlink: Record<string, string>;
    pyth: { contract: string; ids: Record<string, string> };
  };
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
  ];
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

export function collateralOf(d: DeploymentFile): string | undefined {
  return d.hunchBook.usdc ?? d.external.usdc;
}

/** A network gets an indexer config once every contract the indexer reads has an address. */
export function isDeployed(d: DeploymentFile): boolean {
  const h = d.hunchBook;
  return Boolean(h.factory && h.vault && h.router && h.graduator && collateralOf(d) && h.deployBlock);
}

export function networkConstants(d: DeploymentFile): NetworkConstants {
  const h = d.hunchBook;
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
    ours: {
      maker: d.wallets.maker.toLowerCase(),
      keeper: d.wallets.keeper.toLowerCase(),
      guardian: lower(h.guardian),
      feeRecipient: lower(h.feeRecipient),
    },
    kuru: {
      router: d.external.kuru.router.toLowerCase(),
      marginAccount: d.external.kuru.marginAccount.toLowerCase(),
    },
    perps: invert(d.external.perpl.perps, false),
    chainlinkFeeds: invert(d.external.chainlink, true),
    pythIds: invert(d.external.pyth.ids, true),
  };
}

export function renderConfig(d: DeploymentFile, rpcEnv: string): string {
  const h = d.hunchBook;
  if (!isDeployed(d)) throw new Error(`${d.network} has no Hunch Book addresses yet`);
  const contracts = contractEvents();
  const staticAddress: Record<string, string | undefined> = {
    HunchBookFactory: h.factory,
    CollateralVault: h.vault,
    HunchRouter: h.router,
    Graduator: h.graduator,
    Usdc: collateralOf(d),
  };
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
    "    contracts:",
  );
  for (const c of contracts) {
    lines.push(`      - name: ${c.name}`);
    if (c.dynamic) continue;
    const address = staticAddress[c.name];
    if (!address) throw new Error(`no address for ${c.name} on ${d.network}`);
    lines.push(`        address: "${address}"`);
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
