import {
  collateralOf,
  collateralVaultAbi,
  hunchBookFactoryAbi,
  hunchRouterAbi,
  marketAbi,
  marketKey,
  Outcome,
  Phase,
  Side,
  snapshotResolverAbi,
  type TradeKind,
  testUsdcAbi,
} from "@hunch-book/shared";
import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  isAddressEqual,
  isHex,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
} from "viem";
import { type HunchContext, requireWallet } from "./context.js";
import { HunchError } from "./errors.js";
import { getPosition, type MarketInfo, requireMarket } from "./markets.js";
import { encodeMarketParams, type MarketParamsInput } from "./params.js";
import { DEFAULT_SLIPPAGE_BPS, type Quote, quote as readQuote } from "./quotes.js";
import { chainNow, planSettlement } from "./settlement/evidence.js";
import {
  type ApprovalMode,
  balanceOf,
  ensureAllowance,
  type SendOptions,
  send,
  type TxResult,
} from "./tx.js";
import { formatUsdc } from "./units.js";

// Every lifecycle action a person or a bot can take, each one simulated first (reverts come back in
// plain words) and returned with its explorer link: create a market, stake (directly or from a signed
// USDC authorisation a relayer submits), graduate, claim tokens, trade through the router with a
// slippage limit, mint and merge complete sets, settle with evidence found automatically, prove a
// touch, void after the deadline, redeem, and claim a pool payout.

export type SideInput = Side | "yes" | "no" | "YES" | "NO";

export function toSide(side: SideInput): Side {
  if (side === Side.Yes || side === "yes" || side === "YES") return Side.Yes;
  if (side === Side.No || side === "no" || side === "NO") return Side.No;
  throw new HunchError(`Unknown side ${String(side)}: use "yes" or "no".`);
}

function addresses(ctx: HunchContext): {
  factory: Address;
  vault: Address;
  usdc: Address;
  router: Address | undefined;
} {
  const hb = ctx.deployment.hunchBook;
  const usdc = collateralOf(ctx.deployment);
  if (!hb.factory || !hb.vault || !usdc) {
    throw new HunchError(`Hunch Book is not deployed on ${ctx.deployment.network} yet.`);
  }
  return { factory: hb.factory, vault: hb.vault, usdc, router: hb.router };
}

/** The collateral token (test USDC on testnet, Circle USDC on mainnet). */
export function usdcAddress(ctx: HunchContext): Address {
  return addresses(ctx).usdc;
}

// ---------------------------------------------------------------- creating and staking

export interface CreateMarketInput {
  templateId: number;
  /** Encoded params, or typed params for templates 1 to 7 (encoded canonically by the SDK). */
  params: Hex | MarketParamsInput["params"];
  /** The creator's first stake: which side, and how much USDC (base units). */
  side: SideInput;
  firstStake: bigint;
}

export function encodeCreateParams(input: Pick<CreateMarketInput, "templateId" | "params">): Hex {
  if (typeof input.params === "string") {
    if (!isHex(input.params)) throw new HunchError("params must be hex bytes or a typed params object.");
    return input.params;
  }
  return encodeMarketParams({ templateId: input.templateId, params: input.params } as MarketParamsInput);
}

/**
 * Creates a market and makes the creator's first stake. Approves the vault for the stake first if
 * needed. Throws with the existing market's address if the same question exists already.
 */
export async function createMarket(
  ctx: HunchContext,
  input: CreateMarketInput,
  options: { approval?: ApprovalMode } & SendOptions = {},
): Promise<TxResult<Address> & { market: Address }> {
  const { factory, vault, usdc } = addresses(ctx);
  const params = encodeCreateParams(input);
  const existing = await ctx.publicClient.readContract({
    address: factory,
    abi: hunchBookFactoryAbi,
    functionName: "marketOf",
    args: [marketKey(input.templateId, params)],
  });
  if (!isAddressEqual(existing, zeroAddress)) {
    throw new HunchError(`A market with exactly these parameters already exists: ${existing}.`, {
      code: "MarketExists",
    });
  }
  await ensureAllowance(ctx, usdc, vault, input.firstStake, options);
  const tx = await send<Address>(
    ctx,
    {
      address: factory,
      abi: hunchBookFactoryAbi,
      functionName: "createMarket",
      args: [input.templateId, params, toSide(input.side), input.firstStake],
    },
    options,
  );
  return { ...tx, market: getAddress(tx.result) };
}

/** Stakes `amount` USDC on `side` in a pool. Approves the vault first if needed. */
export async function stake(
  ctx: HunchContext,
  market: Address,
  side: SideInput,
  amount: bigint,
  options: { approval?: ApprovalMode } & SendOptions = {},
): Promise<TxResult> {
  const { vault, usdc } = addresses(ctx);
  await ensureAllowance(ctx, usdc, vault, amount, options);
  return send(
    ctx,
    { address: market, abi: marketAbi, functionName: "stake", args: [toSide(side), amount] },
    options,
  );
}

const usdcDomainAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
]);

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface StakeAuthorization {
  market: Address;
  user: Address;
  side: Side;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: Hex;
  /** keccak256(abi.encode(chainid, market, user, side, salt)): binds the signature to this market and side. */
  nonce: Hex;
  /** EIP-712 typed data for USDC's `receiveWithAuthorization` (EIP-3009), ready for signTypedData. */
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: typeof RECEIVE_WITH_AUTHORIZATION_TYPES;
    primaryType: "ReceiveWithAuthorization";
    message: {
      from: Address;
      to: Address;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Hex;
    };
  };
}

/** The nonce `stakeWithAuthorization` requires, computed as IMarket.authorizationNonce does. */
export function authorizationNonce(
  chainId: number,
  market: Address,
  user: Address,
  side: Side,
  salt: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint8" }, { type: "bytes32" }],
      [BigInt(chainId), market, user, side, salt],
    ),
  );
}

/**
 * Builds the typed data a user signs so a relayer can stake for them (gasless staking, docs/PROTOCOL.md
 * §9.5). The signed USDC authorisation pays exactly `amount` to this market, for this side only.
 */
export async function buildStakeAuthorization(
  ctx: HunchContext,
  input: {
    market: Address;
    user: Address;
    side: SideInput;
    amount: bigint;
    validAfter?: bigint;
    /** Unix seconds. Default: one hour from the chain's latest block. */
    validBefore?: bigint;
    /** Any 32 bytes; random by default. */
    salt?: Hex;
  },
): Promise<StakeAuthorization> {
  const usdc = usdcAddress(ctx);
  const side = toSide(input.side);
  const salt = input.salt ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
  const [name, version, now] = await Promise.all([
    ctx.publicClient.readContract({ address: usdc, abi: usdcDomainAbi, functionName: "name" }),
    ctx.publicClient
      .readContract({ address: usdc, abi: usdcDomainAbi, functionName: "version" })
      .catch(() => "2"),
    input.validBefore === undefined ? chainNow(ctx) : Promise.resolve(null),
  ]);
  const validAfter = input.validAfter ?? 0n;
  const validBefore = input.validBefore ?? (now as { timestamp: bigint }).timestamp + 3_600n;
  const nonce = authorizationNonce(ctx.deployment.chainId, input.market, input.user, side, salt);
  return {
    market: input.market,
    user: input.user,
    side,
    amount: input.amount,
    validAfter,
    validBefore,
    salt,
    nonce,
    typedData: {
      domain: { name, version, chainId: ctx.deployment.chainId, verifyingContract: usdc },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: { from: input.user, to: input.market, value: input.amount, validAfter, validBefore, nonce },
    },
  };
}

/** Signs a stake authorisation with the wallet client (the wallet must be the user). */
export async function signStakeAuthorization(
  ctx: HunchContext,
  auth: StakeAuthorization,
): Promise<StakeAuthorization & { signature: Hex }> {
  const wallet = requireWallet(ctx);
  if (!isAddressEqual(wallet.account.address, auth.user)) {
    throw new HunchError("Only the user named in the authorisation can sign it.");
  }
  const signature = await wallet.signTypedData({ account: wallet.account, ...auth.typedData });
  return { ...auth, signature };
}

/** Submits a signed stake authorisation (the wallet is the relayer and pays the gas). */
export async function stakeWithAuthorization(
  ctx: HunchContext,
  signed: StakeAuthorization & { signature: Hex },
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    {
      address: signed.market,
      abi: marketAbi,
      functionName: "stakeWithAuthorization",
      args: [
        signed.user,
        signed.side,
        signed.amount,
        signed.validAfter,
        signed.validBefore,
        signed.salt,
        signed.signature,
      ],
    },
    options,
  );
}

// ---------------------------------------------------------------- lifecycle

export async function graduate(
  ctx: HunchContext,
  market: Address,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(ctx, { address: market, abi: marketAbi, functionName: "graduate" }, options);
}

export async function claimTokens(
  ctx: HunchContext,
  market: Address,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(ctx, { address: market, abi: marketAbi, functionName: "claimTokens" }, options);
}

/** Pushes token claims to many stakers; anyone can call it. */
export async function claimTokensFor(
  ctx: HunchContext,
  market: Address,
  users: readonly Address[],
  options: SendOptions = {},
): Promise<TxResult> {
  return send(
    ctx,
    { address: market, abi: marketAbi, functionName: "claimTokensFor", args: [users] },
    options,
  );
}

export async function claimPool(
  ctx: HunchContext,
  market: Address,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(ctx, { address: market, abi: marketAbi, functionName: "claimPool" }, options);
}

export async function voidIfExpired(
  ctx: HunchContext,
  market: Address,
  options: SendOptions = {},
): Promise<TxResult> {
  return send(ctx, { address: market, abi: marketAbi, functionName: "voidIfExpired" }, options);
}

/**
 * Settles a market. Without `evidence`, finds it (templates 1 to 7) and dry-runs the resolver first,
 * so a market that cannot settle yet throws with the reason instead of sending a failing transaction.
 * A touch market proved before close is settled through `proveYes`.
 */
export async function settle(
  ctx: HunchContext,
  market: Address | MarketInfo,
  options: { evidence?: Hex; value?: bigint } & SendOptions = {},
): Promise<TxResult & { outcome: Outcome | null; method: "settle" | "proveYes" }> {
  const m = await requireMarket(ctx, market);
  if (options.evidence !== undefined) {
    const tx = await send(
      ctx,
      {
        address: m.address,
        abi: marketAbi,
        functionName: "settle",
        args: [options.evidence],
        value: options.value ?? 0n,
      },
      options,
    );
    return { ...tx, outcome: null, method: "settle" };
  }
  const plan = await planSettlement(ctx, m);
  if (plan.status !== "ready")
    throw new HunchError(plan.reason, {
      code: `Settlement${plan.status[0]?.toUpperCase()}${plan.status.slice(1)}`,
    });
  const tx = await send(
    ctx,
    {
      address: m.address,
      abi: marketAbi,
      functionName: plan.method,
      args: [plan.evidence],
      value: plan.value,
    },
    options,
  );
  return { ...tx, outcome: plan.outcome, method: plan.method };
}

/** Touch templates (3 and 4): settles YES before close from a proof. Finds the proof when none is given. */
export async function proveYes(
  ctx: HunchContext,
  market: Address | MarketInfo,
  options: { proof?: Hex } & SendOptions = {},
): Promise<TxResult> {
  const m = await requireMarket(ctx, market);
  let proof = options.proof;
  if (proof === undefined) {
    const plan = await planSettlement(ctx, m);
    if (plan.status !== "ready") throw new HunchError(plan.reason);
    if (plan.outcome !== Outcome.Yes)
      throw new HunchError("No touch to prove: the market can only settle NO.");
    proof = plan.evidence;
  }
  return send(ctx, { address: m.address, abi: marketAbi, functionName: "proveYes", args: [proof] }, options);
}

/**
 * Template 7: takes the snapshot a market answers from, without settling it (anyone, once per
 * observation, inside [closeTime, closeTime + snapshotWindow]). Every market on the same source, close
 * time and window answers from it. `settle` also takes it when nobody has, so this is only needed to
 * fix the value before settling, for example for many markets at once.
 */
export async function takeSnapshot(
  ctx: HunchContext,
  market: Address | MarketInfo,
  options: SendOptions = {},
): Promise<TxResult<bigint>> {
  const m = await requireMarket(ctx, market);
  if (m.decoded.kind !== "snapshot")
    throw new HunchError("Only snapshot markets (template 7) take a snapshot.");
  const p = m.decoded.params;
  return send<bigint>(
    ctx,
    {
      address: m.resolver,
      abi: snapshotResolverAbi,
      functionName: "snapshot",
      args: [p.sourceId, p.closeTime, p.snapshotWindow],
    },
    options,
  );
}

// ---------------------------------------------------------------- trading

const SHORTFALL: Record<string, string> = {
  empty: "The side of the book this trade needs has no orders.",
  liquidity: "The book cannot fill the whole amount. Try a smaller amount.",
  dust: "The amount is too small to fill anything.",
  price: "Selling NO here would cost more than the merge returns (asks above 1 USDC).",
};

export interface TradeOptions extends SendOptions {
  /** Slippage allowance in basis points. Default 100 (1%). */
  slippageBps?: bigint;
  /** Seconds from the latest block until the trade expires. Default 120. */
  deadlineSeconds?: bigint;
  approval?: ApprovalMode;
  /** A quote already made; the SDK quotes again when it is missing. */
  quote?: Quote;
}

/**
 * Trades through HunchRouter: `amount` is USDC in (buyYes), YES in (sellYes), NO out (buyNo) or NO in
 * (sellNo). Quotes the live book, applies the slippage limit and a deadline, approves the router for
 * the exact input if needed, then sends.
 */
export async function trade(
  ctx: HunchContext,
  market: Address | MarketInfo,
  kind: TradeKind,
  amount: bigint,
  options: TradeOptions = {},
): Promise<TxResult<bigint> & { quote: Quote }> {
  const { usdc, router } = addresses(ctx);
  if (!router) throw new HunchError(`The router is not deployed on ${ctx.deployment.network}.`);
  const m = await requireMarket(ctx, market);
  if (m.phase !== Phase.Graduated) {
    throw new HunchError(
      "This market is not trading on the book right now: it has not graduated, or it has closed.",
      {
        code: "NotTradable",
      },
    );
  }
  const q =
    options.quote ??
    (await readQuote(ctx, m, kind, amount, { slippageBps: options.slippageBps ?? DEFAULT_SLIPPAGE_BPS }));
  if (q.shortfall)
    throw new HunchError(SHORTFALL[q.shortfall] ?? "The book cannot fill this trade.", { code: q.shortfall });
  const token = q.approval.token === "usdc" ? usdc : q.approval.token === "yes" ? m.tokens.yes : m.tokens.no;
  await ensureAllowance(ctx, token, router, q.approval.amount, options);
  const now = await chainNow(ctx);
  const deadline = now.timestamp + (options.deadlineSeconds ?? 120n);
  const tx = await send<bigint>(
    ctx,
    {
      address: router,
      abi: hunchRouterAbi,
      functionName: kind,
      args: [m.address, amount, q.limit, deadline],
    },
    options,
  );
  return { ...tx, quote: q };
}

/** Pays `amount` USDC for `amount` YES + `amount` NO (only while trading). Approves the vault if needed. */
export async function mintSets(
  ctx: HunchContext,
  market: Address,
  amount: bigint,
  options: { to?: Address; approval?: ApprovalMode } & SendOptions = {},
): Promise<TxResult> {
  const { vault, usdc } = addresses(ctx);
  const to = options.to ?? requireWallet(ctx).account.address;
  await ensureAllowance(ctx, usdc, vault, amount, options);
  return send(
    ctx,
    { address: vault, abi: collateralVaultAbi, functionName: "mintSets", args: [market, amount, to] },
    options,
  );
}

/** Burns `amount` YES + `amount` NO for `amount` USDC (from graduation to settlement, and after a void). */
export async function mergeSets(
  ctx: HunchContext,
  market: Address,
  amount: bigint,
  options: { to?: Address } & SendOptions = {},
): Promise<TxResult> {
  const { vault } = addresses(ctx);
  const to = options.to ?? requireWallet(ctx).account.address;
  return send(
    ctx,
    { address: vault, abi: collateralVaultAbi, functionName: "mergeSets", args: [market, amount, to] },
    options,
  );
}

// ---------------------------------------------------------------- getting paid

/**
 * Redeems outcome tokens after settlement (winning side, 1 − fee each) or a void (either side, 0.50
 * each). `amount` defaults to the wallet's whole balance of that side.
 */
export async function redeem(
  ctx: HunchContext,
  market: Address | MarketInfo,
  side: SideInput,
  options: { amount?: bigint; to?: Address } & SendOptions = {},
): Promise<TxResult<bigint>> {
  const { vault } = addresses(ctx);
  const m = await requireMarket(ctx, market);
  const s = toSide(side);
  const me = requireWallet(ctx).account.address;
  const amount = options.amount ?? (await balanceOf(ctx, s === Side.Yes ? m.tokens.yes : m.tokens.no, me));
  if (amount === 0n)
    throw new HunchError(`This wallet holds no ${s === Side.Yes ? "YES" : "NO"} tokens of market #${m.id}.`);
  return send<bigint>(
    ctx,
    {
      address: vault,
      abi: collateralVaultAbi,
      functionName: "redeem",
      args: [m.address, s, amount, options.to ?? me],
    },
    options,
  );
}

/**
 * Everything it takes to get a settled or voided market's USDC into the wallet: claims unclaimed
 * tokens, claims a pool payout or refund, and redeems the winning side (both sides after a void).
 * Returns each transaction sent, in order; an empty list means there was nothing to collect.
 */
export async function collect(
  ctx: HunchContext,
  market: Address | MarketInfo,
  options: SendOptions = {},
): Promise<TxResult[]> {
  const m = await requireMarket(ctx, market);
  if (m.phase !== Phase.Settled && m.phase !== Phase.Voided) {
    throw new HunchError("The market has not settled or voided yet, so there is nothing to collect.");
  }
  const me = requireWallet(ctx).account.address;
  const out: TxResult[] = [];
  let position = await getPosition(ctx, m, me);
  if (position.claimableTokens.yes + position.claimableTokens.no > 0n) {
    out.push(await claimTokens(ctx, m.address, options));
    position = await getPosition(ctx, m, me);
  }
  if (!m.graduated && position.claimablePool.paid > 0n) out.push(await claimPool(ctx, m.address, options));
  const sides: Side[] =
    m.phase === Phase.Voided
      ? [Side.Yes, Side.No]
      : m.outcome === Outcome.Yes
        ? [Side.Yes]
        : m.outcome === Outcome.No
          ? [Side.No]
          : [];
  for (const side of sides) {
    const balance = side === Side.Yes ? position.balances.yes : position.balances.no;
    // A void pays 0.50 per token, rounded down: an odd last unit pays nothing, so redeem an even amount.
    const amount = m.phase === Phase.Voided ? balance - (balance % 2n) : balance;
    if (amount > 0n) out.push(await redeem(ctx, m, side, { amount, ...options }));
  }
  return out;
}

/** Withdraws the creator's 25% share of fees on markets this wallet created. */
export async function withdrawCreatorFees(
  ctx: HunchContext,
  options: { to?: Address } & SendOptions = {},
): Promise<TxResult<bigint>> {
  const { vault } = addresses(ctx);
  const to = options.to ?? requireWallet(ctx).account.address;
  return send<bigint>(
    ctx,
    { address: vault, abi: collateralVaultAbi, functionName: "withdrawCreatorFees", args: [to] },
    options,
  );
}

/** Testnet only: mints Hunch Book's test USDC (at most 10,000 per call) to the wallet or `to`. */
export async function mintTestUsdc(
  ctx: HunchContext,
  amount: bigint,
  options: { to?: Address } & SendOptions = {},
): Promise<TxResult> {
  if (ctx.deployment.network !== "monad-testnet" || !ctx.deployment.hunchBook.usdc) {
    throw new HunchError("The test USDC faucet exists only on Monad testnet.");
  }
  if (amount > 10_000_000_000n)
    throw new HunchError(`The faucet gives at most 10,000 USDC per call, not ${formatUsdc(amount)}.`);
  const to = options.to ?? requireWallet(ctx).account.address;
  return send(
    ctx,
    { address: ctx.deployment.hunchBook.usdc, abi: testUsdcAbi, functionName: "mint", args: [to, amount] },
    options,
  );
}
