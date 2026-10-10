import {
  collateralOf,
  collateralVaultAbi,
  type Deployment,
  defaultStackOf,
  hunchBookFactoryAbi,
  marketAbi,
  type Stack,
  stackNamed,
  stacksOf,
  type Venue,
  type Window,
} from "@hunch-book/shared";
import { type Abi, type Address, type ContractFunctionParameters, erc20Abi, zeroAddress } from "viem";
import { MULTICALL3 } from "../chain/client";

// One snapshot of everything the status page checks, per stack, read from the contracts in
// deployments/<network>.json with a few multicalls at a single block. No indexer, no server. Each stack
// has its own factory and vault, so each is checked on its own.

/** The most markets the page reads; beyond this the breakdown is marked partial. */
export const STATUS_MARKET_LIMIT = 400;

const BATCH_BYTES = 16_384;

export interface StatusMarket {
  address: Address;
  marketId: bigint;
  templateId: number;
  phase: number;
  outcome: number;
  graduated: boolean;
  ruleMet: boolean;
  window: Window;
  creator: Address;
  /** The vault's ledger for the market. */
  ledger: { status: number; pool: bigint; sets: bigint };
  yesSupply: bigint;
  noSupply: bigint;
  /** The stack's Kuru version and venue (lib/stacks.ts marketTag), absent on the primary Kuru v1 stack. */
  kuruVersion?: 1 | 2;
  venue?: Venue;
}

/** Which stack a snapshot read: its name ("primary" or a key under `stacks`) and where its books are. */
export interface StatusStack {
  name: string;
  primary: boolean;
  venue: Venue;
  kuruVersion: 1 | 2;
  /** The stack new markets go to (deployments `defaultStack`). */
  isDefault: boolean;
}

export interface StatusSnapshot {
  /** The stack read; absent means the primary one (older callers and tests). */
  stack?: StatusStack;
  block: bigint;
  /** Unix seconds of `block`. */
  timestamp: number;
  /** Seconds per block, measured over the last 10,000 blocks (null if the chain is younger). */
  secondsPerBlock: number | null;
  vault: {
    address: Address;
    usdc: Address;
    balance: bigint;
    totalObligations: bigint;
    surplus: bigint;
    protocolFees: bigint;
    totalCollateral: bigint;
    collateralCap: bigint;
  };
  factory: {
    address: Address;
    guardian: Address;
    pendingGuardian: Address;
    feeRecipient: Address;
    creationPaused: boolean;
    graduationPaused: boolean;
    marketCount: number;
  };
  markets: StatusMarket[];
  /** True when the factory has more markets than the page read. */
  partial: boolean;
  creatorFees: { creator: Address; fees: bigint }[];
  wallets: { keeper: bigint; maker: bigint };
}

type Client = {
  multicall(args: {
    contracts: readonly ContractFunctionParameters[];
    allowFailure: false;
    multicallAddress: Address;
    batchSize?: number;
    blockNumber?: bigint;
  }): Promise<unknown[]>;
  getBlock(args?: { blockNumber?: bigint }): Promise<{ number: bigint; timestamp: bigint }>;
  getBalance(args: { address: Address; blockNumber?: bigint }): Promise<bigint>;
};

const call = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
  ({ address, abi, functionName, ...(args ? { args } : {}) }) as unknown as ContractFunctionParameters;

const MARKET_FIELDS = [
  "marketId",
  "templateId",
  "phase",
  "outcome",
  "graduated",
  "graduationRuleMet",
  "window",
  "creator",
  "tokens",
] as const;

/** The snapshot of one stack (default: the primary one). */
export async function readStatusSnapshot(
  client: Client,
  deployment: Deployment,
  stackName = "primary",
): Promise<StatusSnapshot> {
  const stack = stackNamed(deployment, stackName);
  const { factory, vault } = stack?.contracts ?? {};
  const usdc = stack?.contracts.usdc ?? collateralOf(deployment);
  if (!stack || !factory || !vault || !usdc) {
    throw new Error(`Hunch Book is not deployed on ${deployment.network}.`);
  }
  const tag = stack.primary && stack.kuruVersion === 1 && stack.venue === "kuru" ? {} : venueTag(stack);

  const head = await client.getBlock();
  const blockNumber = head.number;
  const many = (contracts: ContractFunctionParameters[]) =>
    client.multicall({
      contracts,
      allowFailure: false,
      multicallAddress: MULTICALL3,
      batchSize: BATCH_BYTES,
      blockNumber,
    });

  const vaultAbi = collateralVaultAbi as Abi;
  const factoryAbi = hunchBookFactoryAbi as Abi;
  const top = await many([
    call(usdc, erc20Abi as Abi, "balanceOf", [vault]),
    call(vault, vaultAbi, "totalObligations"),
    call(vault, vaultAbi, "surplus"),
    call(vault, vaultAbi, "protocolFees"),
    call(vault, vaultAbi, "totalCollateral"),
    call(vault, vaultAbi, "collateralCap"),
    call(factory, factoryAbi, "guardian"),
    call(factory, factoryAbi, "pendingGuardian"),
    call(factory, factoryAbi, "feeRecipient"),
    call(factory, factoryAbi, "creationPaused"),
    call(factory, factoryAbi, "graduationPaused"),
    call(factory, factoryAbi, "marketCount"),
  ]);
  const marketCount = Number(top[11] as bigint);
  const readCount = Math.min(marketCount, STATUS_MARKET_LIMIT);

  const addresses = (await many(
    Array.from({ length: readCount }, (_, i) => call(factory, factoryAbi, "marketAt", [BigInt(i)])),
  )) as Address[];

  const fields = (await many(
    addresses.flatMap((address) => MARKET_FIELDS.map((f) => call(address, marketAbi as Abi, f))),
  )) as unknown[];
  const per = MARKET_FIELDS.length;
  const partials = addresses.map((address, i) => {
    const at = (k: number) => fields[i * per + k];
    const tokens = at(8) as readonly [Address, Address];
    return {
      address,
      marketId: at(0) as bigint,
      templateId: Number(at(1)),
      phase: Number(at(2)),
      outcome: Number(at(3)),
      graduated: at(4) as boolean,
      ruleMet: at(5) as boolean,
      window: at(6) as Window,
      creator: at(7) as Address,
      tokens,
    };
  });

  const second = (await many(
    partials.flatMap((m) => [
      call(vault, vaultAbi, "ledger", [m.address]),
      call(m.tokens[0], erc20Abi as Abi, "totalSupply"),
      call(m.tokens[1], erc20Abi as Abi, "totalSupply"),
    ]),
  )) as unknown[];
  const markets: StatusMarket[] = partials.map(({ tokens: _tokens, ...m }, i) => {
    const ledger = second[i * 3] as { status: number; pool: bigint; sets: bigint };
    return {
      ...m,
      ledger: { status: Number(ledger.status), pool: BigInt(ledger.pool), sets: BigInt(ledger.sets) },
      yesSupply: second[i * 3 + 1] as bigint,
      noSupply: second[i * 3 + 2] as bigint,
      ...tag,
    };
  });

  const byCreator = new Map<string, Address>();
  for (const m of markets) if (m.creator !== zeroAddress) byCreator.set(m.creator.toLowerCase(), m.creator);
  const creators = [...byCreator.values()];
  const fees = (await many(creators.map((c) => call(vault, vaultAbi, "creatorFees", [c])))) as bigint[];

  const [earlier, keeper, maker] = await Promise.all([
    head.number > 10_000n ? client.getBlock({ blockNumber: head.number - 10_000n }) : Promise.resolve(null),
    client.getBalance({ address: deployment.wallets.keeper, blockNumber }),
    client.getBalance({ address: deployment.wallets.maker, blockNumber }),
  ]);

  return {
    stack: {
      name: stack.name,
      primary: stack.primary,
      venue: stack.venue,
      kuruVersion: stack.kuruVersion,
      isDefault: stack.name === defaultStackOf(deployment)?.name,
    },
    block: head.number,
    timestamp: Number(head.timestamp),
    secondsPerBlock: earlier ? Number(head.timestamp - earlier.timestamp) / 10_000 : null,
    vault: {
      address: vault,
      usdc,
      balance: top[0] as bigint,
      totalObligations: top[1] as bigint,
      surplus: top[2] as bigint,
      protocolFees: top[3] as bigint,
      totalCollateral: top[4] as bigint,
      collateralCap: top[5] as bigint,
    },
    factory: {
      address: factory,
      guardian: top[6] as Address,
      pendingGuardian: top[7] as Address,
      feeRecipient: top[8] as Address,
      creationPaused: top[9] as boolean,
      graduationPaused: top[10] as boolean,
      marketCount,
    },
    markets,
    partial: marketCount > readCount,
    creatorFees: creators.map((creator, i) => ({ creator, fees: fees[i] ?? 0n })),
    wallets: { keeper, maker },
  };
}

const venueTag = (stack: Stack): Pick<StatusMarket, "kuruVersion" | "venue"> => ({
  kuruVersion: stack.kuruVersion,
  venue: stack.venue,
});

/** One snapshot per stack with a factory and a vault, the primary first. */
export async function readStatusSnapshots(client: Client, deployment: Deployment): Promise<StatusSnapshot[]> {
  const stacks = stacksOf(deployment).filter((s) => s.contracts.factory && s.contracts.vault);
  if (stacks.length === 0) throw new Error(`Hunch Book is not deployed on ${deployment.network}.`);
  return Promise.all(stacks.map((s) => readStatusSnapshot(client, deployment, s.name)));
}
