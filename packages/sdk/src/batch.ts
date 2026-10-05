import { collateralVaultAbi, marketAbi, Outcome, Phase, Side, txUrl } from "@hunch-book/shared";
import { type Abi, type Address, encodeFunctionData, type Hex } from "viem";
import { accountAddress, type HunchContext, requireWallet } from "./context.js";
import { HunchError } from "./errors.js";
import { getPosition, type MarketInfo, type Position, requireMarket } from "./markets.js";
import { type ContractCall, type SendOptions, send, type TxResult } from "./tx.js";
import { formatUsdc } from "./units.js";

// Collecting from many markets at once. `planCollect` turns one wallet's positions into the exact calls
// that get their USDC out (claim tokens, claim a pool payout, redeem); `sendCalls` sends any list of
// calls either as one atomic batch (EIP-5792 `wallet_sendCalls`, when the wallet says it can do that
// on this chain: one confirmation, all or nothing) or one transaction at a time; `collectAll` is the two
// together. Every call is still built from the protocol's own functions, so nothing here can do more
// than the person could click.

export type CollectKind = "claimTokens" | "claimPool" | "redeem";

export interface PlannedCall extends ContractCall {
  kind: CollectKind;
  market: Address;
  /** What this call does, in words. */
  label: string;
  /** Redeem only: the side and the tokens burned. */
  side?: Side;
  amount?: bigint;
}

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };

/**
 * The calls that collect one settled or voided market for `position`'s owner, in order. Unclaimed
 * tokens are claimed first and counted in the redemption, since `claimTokens` transfers exactly the
 * claimable amounts. A void pays 0.50 per token rounded down, so an odd last unit is left alone. A
 * market that has not settled or voided needs nothing. The USDC goes to `owner`.
 */
export function collectCalls(
  m: MarketInfo,
  position: Position,
  vault: Address,
  owner: Address,
): PlannedCall[] {
  if (m.phase !== Phase.Settled && m.phase !== Phase.Voided) return [];
  const calls: PlannedCall[] = [];
  const claimable = position.claimableTokens;
  if (m.graduated && claimable.yes + claimable.no > 0n) {
    calls.push({
      kind: "claimTokens",
      market: m.address,
      label: `Claim ${formatUsdc(claimable.yes)} YES and ${formatUsdc(claimable.no)} NO on market #${m.id}`,
      address: m.address,
      abi: marketAbi,
      functionName: "claimTokens",
    });
  }
  if (!m.graduated && position.claimablePool.paid > 0n) {
    calls.push({
      kind: "claimPool",
      market: m.address,
      label: `Claim ${formatUsdc(position.claimablePool.paid)} USDC from market #${m.id}'s pool`,
      address: m.address,
      abi: marketAbi,
      functionName: "claimPool",
    });
  }
  if (!m.graduated) return calls;
  const sides: Side[] =
    m.phase === Phase.Voided
      ? [Side.Yes, Side.No]
      : m.outcome === Outcome.Yes
        ? [Side.Yes]
        : m.outcome === Outcome.No
          ? [Side.No]
          : [];
  for (const side of sides) {
    const held =
      side === Side.Yes ? position.balances.yes + claimable.yes : position.balances.no + claimable.no;
    const amount = m.phase === Phase.Voided ? held - (held % 2n) : held;
    if (amount === 0n) continue;
    calls.push({
      kind: "redeem",
      market: m.address,
      label: `Redeem ${formatUsdc(amount)} ${SIDE_NAME[side]} on market #${m.id}`,
      side,
      amount,
      address: vault,
      abi: collateralVaultAbi,
      functionName: "redeem",
      args: [m.address, side, amount, owner],
    });
  }
  return calls;
}

/**
 * Every call that collects these markets for `owner` (the wallet's own address by default), market by
 * market. Markets still open are skipped.
 */
export async function planCollect(
  ctx: HunchContext,
  markets: readonly (Address | MarketInfo)[],
  owner?: Address,
): Promise<PlannedCall[]> {
  const who = owner ?? accountAddress(ctx);
  if (!who) throw new HunchError("Planning a collection needs an owner address or a wallet.");
  const vault = ctx.deployment.hunchBook.vault as Address;
  const out: PlannedCall[] = [];
  for (const market of markets) {
    const m = await requireMarket(ctx, market);
    const position = await getPosition(ctx, m, who);
    out.push(...collectCalls(m, position, vault, who));
  }
  return out;
}

export type BatchMode = "atomic" | "sequential";

export interface BatchResult {
  /** How the calls went out. */
  mode: BatchMode;
  /** The wallet's id for the batch (atomic only). */
  batchId?: string;
  /** Every transaction that landed, with its explorer link. One for an atomic batch on most wallets. */
  transactions: { hash: Hex; url: string; status: "success" | "reverted" }[];
}

/**
 * Whether the wallet can send calls on `chainId` as one atomic batch, from its EIP-5792
 * `wallet_getCapabilities` answer. "ready" means the wallet will upgrade the account first (EIP-7702)
 * and asks about that in the same confirmation.
 */
export function atomicSupported(capabilities: unknown, chainId: number): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const caps = capabilities as Record<string, unknown>;
  // viem returns the chain's own capabilities when asked for one chain, or a map by chain id.
  const forChain = (caps[chainId] ?? caps[`0x${chainId.toString(16)}`] ?? caps) as Record<string, unknown>;
  const atomic = forChain?.atomic as { status?: string } | undefined;
  return atomic?.status === "supported" || atomic?.status === "ready";
}

/** Asks the wallet, and treats any error (no EIP-5792, a local key) as "no". */
export async function canBatchAtomically(ctx: HunchContext): Promise<boolean> {
  const wallet = requireWallet(ctx);
  try {
    const caps = await wallet.getCapabilities({ account: wallet.account, chainId: ctx.chain.id });
    return atomicSupported(caps, ctx.chain.id);
  } catch {
    return false;
  }
}

export interface SendCallsOptions extends SendOptions {
  /**
   * "auto" (the default) sends one atomic batch when the wallet supports it and one transaction at a
   * time otherwise; "atomic" requires the batch; "sequential" never batches.
   */
  mode?: "auto" | BatchMode;
}

/**
 * Sends the calls. Sequentially, each is simulated and confirmed before the next, and the first revert
 * stops the rest. As an atomic batch, the wallet runs them in one confirmation and either all land or
 * none do.
 */
export async function sendCalls(
  ctx: HunchContext,
  calls: readonly ContractCall[],
  options: SendCallsOptions = {},
): Promise<BatchResult> {
  if (calls.length === 0) return { mode: "sequential", transactions: [] };
  const mode = options.mode ?? "auto";
  const supported = mode === "sequential" ? false : await canBatchAtomically(ctx);
  if (mode === "atomic" && !supported) {
    throw new HunchError("This wallet cannot send an atomic batch on this chain (EIP-5792).", {
      code: "AtomicUnsupported",
    });
  }
  // One call gains nothing from a batch, unless the caller asked for one.
  const atomic = supported && (mode === "atomic" || calls.length > 1);
  if (!atomic) {
    const transactions: BatchResult["transactions"] = [];
    for (const call of calls) {
      const r: TxResult = await send(ctx, call, options);
      transactions.push({ hash: r.hash, url: r.url, status: "success" });
    }
    return { mode: "sequential", transactions };
  }
  const wallet = requireWallet(ctx);
  let id: string;
  try {
    const sent = await wallet.sendCalls({
      account: wallet.account,
      chain: ctx.chain,
      forceAtomic: true,
      calls: calls.map((c) => ({
        to: c.address,
        data: encodeFunctionData({
          abi: c.abi as Abi,
          functionName: c.functionName,
          args: c.args ?? [],
        } as never),
        ...(c.value ? { value: c.value } : {}),
      })),
    });
    id = sent.id;
  } catch (e) {
    throw HunchError.from(e);
  }
  if (options.wait === false) return { mode: "atomic", batchId: id, transactions: [] };
  const status = await wallet.waitForCallsStatus({ id });
  const transactions = (status.receipts ?? []).map((r) => ({
    hash: r.transactionHash,
    url: txUrl(ctx.deployment, r.transactionHash),
    status: r.status === "success" ? ("success" as const) : ("reverted" as const),
  }));
  if (status.status !== "success") {
    throw new HunchError(
      `The batch did not go through, so nothing moved${transactions[0] ? `: ${transactions[0].url}` : "."}`,
      { code: "Reverted" },
    );
  }
  return { mode: "atomic", batchId: id, transactions };
}

/** Plans and sends a collection across markets: one confirmation where the wallet can batch. */
export async function collectAll(
  ctx: HunchContext,
  markets: readonly (Address | MarketInfo)[],
  options: SendCallsOptions = {},
): Promise<BatchResult & { calls: PlannedCall[] }> {
  const calls = await planCollect(ctx, markets);
  const result = await sendCalls(ctx, calls, options);
  return { ...result, calls };
}
