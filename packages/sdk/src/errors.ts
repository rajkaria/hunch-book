import {
  autoRedeemerAbi,
  collateralVaultAbi,
  conditionalOrdersAbi,
  graduatorAbi,
  hunchBookFactoryAbi,
  hunchRouterAbi,
  impliedProbabilityOracleAbi,
  kuruMarginAccountAbi,
  kuruOrderBookAbi,
  marketAbi,
  merkleDistributorAbi,
  outcomeTokenPriceAdapterAbi,
  referralRegistryAbi,
  snapshotResolverAbi,
  testUsdcAbi,
} from "@hunch-book/shared";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Hex,
  parseAbi,
  UserRejectedRequestError,
} from "viem";

// Every custom error a Hunch Book call can revert with, decoded by name and turned into one plain
// sentence. A router trade can revert in the router, the vault, the market, Kuru's book or a token,
// and a settlement in any of seven resolvers, so every simulation carries all of them (KNOWN_ERRORS_ABI).

/** Errors defined in the contracts but not in the interfaces the shared ABIs are generated from. */
const EXTRA_ERRORS = parseAbi([
  // HunchRouter
  "error InsufficientLiquidity()",
  "error AmountTooLarge()",
  "error UnexpectedFlashLoan()",
  "error OnlyVault()",
  "error Reentrancy()",
  "error CollateralMismatch()",
  // Resolvers: shared readers
  "error NonCanonicalParams()",
  "error MalformedEvidence()",
  "error EvidenceNotEmpty()",
  "error DeadlineOverflow()",
  "error NotAContract(address account)",
  // Perpl templates (1 and 4)
  "error ExchangeVersionChanged(uint256 major, uint256 minor, uint256 patch)",
  "error PerpNotListed(uint256 perpId)",
  "error PerpPaused(uint256 perpId)",
  "error FundingNotStarted(uint256 perpId, uint256 fundingStartBlock, uint64 startBlock)",
  "error ScalingExpMismatch(uint256 expected, uint256 actual)",
  "error StartBlockNotInFuture(uint64 startBlock, uint256 currentBlock)",
  "error WindowTooShort(uint64 startBlock, uint64 endBlock, uint256 fundingInterval)",
  "error WindowTooLong(uint64 startBlock, uint64 endBlock, uint256 maxBlocks)",
  "error EventOutsideWindow(uint64 eventBlock, uint64 startBlock, uint64 endBlock)",
  "error EventNotFinal(uint64 eventBlock, uint256 currentBlock)",
  "error FundingReadFailed(uint256 blockNumber)",
  "error NotAFundingEvent(uint64 eventBlock, uint256 reportedEventBlock)",
  "error NotOneInterval(uint64 eventBlock, uint256 previousEventBlock, uint256 fundingInterval)",
  "error NotASpike(uint64 eventBlock, int256 increment, int256 threshold)",
  // Price templates (2, 3 and 5)
  "error FeedNotAllowed(address feed)",
  "error PythIdNotAllowed(bytes32 id)",
  "error UnknownSource(uint8 source)",
  "error UnusedFieldSet()",
  "error StrikeNotPositive(int256 strikeE8)",
  "error LowerNotPositive(int256 lowerE8)",
  "error EmptyRange(int256 lowerE8, int256 upperE8)",
  "error LockNotInFuture(uint64 lockTime, uint256 currentTime)",
  "error CloseBeforeLock(uint64 lockTime, uint64 closeTime)",
  "error PhaseBoundary(uint80 roundId)",
  "error RoundNotFound(uint80 roundId)",
  "error RoundAfterTarget(uint80 roundId, uint256 updatedAt, uint256 target)",
  "error RoundNotLastBeforeTarget(uint80 roundId, uint256 nextUpdatedAt, uint256 target)",
  "error RoundTooStale(uint80 roundId, uint256 updatedAt, uint256 target)",
  "error NonPositivePrice(int256 price)",
  "error InsufficientFee(uint256 fee, uint256 sent)",
  "error PythFeedMismatch()",
  "error PythPublishTimeOutOfRange(uint256 publishTime, uint256 target)",
  "error UnknownDirection(uint8 direction)",
  "error StartBeforeLock(uint64 lockTime, uint64 startTime)",
  "error EmptyWindow(uint64 startTime, uint64 endTime)",
  "error WindowTooLong(uint64 startTime, uint64 endTime)",
  "error RoundCarriedOver(uint80 roundId, uint80 answeredInRound)",
  "error RoundOutsideWindow(uint80 roundId, uint256 updatedAt, uint64 startTime, uint64 endTime)",
  "error NoTouch(uint80 roundId, int256 priceE8, int256 strikeE8)",
  // Parlay (6)
  "error LegCount(uint256 count, uint256 minimum, uint256 maximum)",
  "error LegsNotSorted(address leg)",
  "error NotAHunchMarket(address leg)",
  "error LegFinished(address leg)",
  "error LockAfterLeg(address leg, uint64 lockTime, uint256 legEarliestLock)",
]);

type AbiError = Extract<Abi[number], { type: "error" }>;

const errorsOf = (abi: Abi): AbiError[] => abi.filter((item): item is AbiError => item.type === "error");

/** Every custom error the SDK's calls can surface, one entry per signature. */
export const KNOWN_ERRORS_ABI: readonly AbiError[] = (() => {
  const seen = new Set<string>();
  const out: AbiError[] = [];
  const abis = [
    hunchRouterAbi,
    marketAbi,
    collateralVaultAbi,
    hunchBookFactoryAbi,
    graduatorAbi,
    kuruOrderBookAbi,
    kuruMarginAccountAbi,
    testUsdcAbi,
    autoRedeemerAbi,
    conditionalOrdersAbi,
    referralRegistryAbi,
    merkleDistributorAbi,
    impliedProbabilityOracleAbi,
    outcomeTokenPriceAdapterAbi,
    snapshotResolverAbi,
    EXTRA_ERRORS,
  ] as unknown as Abi[];
  for (const abi of abis) {
    for (const e of errorsOf(abi)) {
      const key = `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
})();

/** A call's ABI plus every known error, so a revert from any contract it touches decodes by name. */
export function withKnownErrors<const T extends Abi | readonly unknown[]>(abi: T): T {
  return [...abi, ...KNOWN_ERRORS_ABI] as unknown as T;
}

/** One plain sentence per custom error, by name. */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // creating markets
  CreationIsPaused: "Market creation is paused.",
  UnknownTemplate: "That template id is not registered with the factory.",
  MarketExists: "A market with exactly these parameters already exists.",
  FirstStakeTooSmall: "The creator's first stake is below the minimum.",
  BadWindow: "The resolver returned a window the factory refuses.",
  NonCanonicalParams: "The parameters are not in their one canonical encoding. Encode them with the SDK.",
  FeedNotAllowed: "That price feed is not on the resolver's list.",
  PythIdNotAllowed: "That Pyth price id is not on the resolver's list.",
  UnknownSource:
    "The resolver does not know that source: a price source is 0 (Chainlink) or 1 (Pyth), and a snapshot source is an id from the resolver's list.",
  UnusedFieldSet: "Set only the field for the chosen price source: the feed for Chainlink, the id for Pyth.",
  StrikeNotPositive: "The strike must be above zero.",
  LowerNotPositive: "The lower bound must be above zero.",
  EmptyRange: "The upper bound must be above the lower bound.",
  LockNotInFuture: "The lock time must be in the future.",
  CloseBeforeLock: "The close must be at or after the lock.",
  StartBeforeLock: "The window must start at or after the lock.",
  EmptyWindow: "The window must end after it starts.",
  WindowTooLong: "The window is longer than the template allows (31 days).",
  WindowTooShort: "The window must be at least one Perpl funding interval (8,571 blocks).",
  StartBlockNotInFuture: "The start block must be in the future.",
  PerpNotListed: "That Perpl perp is not listed.",
  PerpPaused: "That Perpl perp is paused.",
  FundingNotStarted: "Funding on that Perpl perp starts after the window's start.",
  ScalingExpMismatch: "The funding scale exponent does not match Perpl's value for this perp.",
  ExchangeVersionChanged: "Perpl's contract version changed since the resolver was deployed.",
  UnknownDirection: "The touch direction must be 0 (at or above) or 1 (at or below).",
  LegCount: "A parlay has 2 to 5 legs.",
  LegsNotSorted: "Parlay legs must be in increasing address order, each once. Encode them with the SDK.",
  NotAHunchMarket: "A parlay leg is not a market of this factory.",
  LegFinished: "A parlay leg has already settled or voided.",
  LockAfterLeg: "A parlay must lock at or before every leg locks.",
  DeadlineOverflow: "The window is too far in the future.",
  UnknownComparator: "The comparator must be 0 (above), 1 (at or above), 2 (below) or 3 (at or below).",
  SnapshotWindowOutOfRange: "The snapshot window must be 60 to 1,800 seconds.",
  // snapshots (template 7)
  OutsideSnapshotWindow: "A snapshot can only be taken inside the market's snapshot window.",
  SnapshotExists: "The snapshot for this source, close time and window was already taken. It is final.",
  SourceCallFailed: "The snapshot source could not be read right now. Try again inside the window.",
  SourceReturnTooShort: "The snapshot source returned less data than the resolver reads.",
  ValueOutOfRange: "The snapshot source returned a value outside the range the resolver accepts.",
  ValueStale: "The snapshot source's value is older than the resolver accepts. Try again inside the window.",
  GuardCallFailed: "The source's version check could not be read right now. Try again inside the window.",
  SourceChanged:
    "The snapshot source no longer means what it meant when the resolver was deployed (an upgrade, a relisting, new units or a pause).",
  // staking
  StakeTooSmall: "That stake is below this market's minimum.",
  PoolCapExceeded: "That stake would take the pool over its cap.",
  WalletCapExceeded: "That stake would take this wallet over the market's limit.",
  WrongPhase: "The market is in another phase, so that is not possible now.",
  MarketNotOpen: "The market is not open.",
  CollateralCapExceeded: "The vault is at its limit for total USDC. Try a smaller amount later.",
  BadAuthorization: "The signed USDC authorisation is malformed.",
  AuthorizationAlreadyUsed: "That USDC authorisation was already used.",
  AuthorizationExpired: "That USDC authorisation has expired.",
  AuthorizationNotYetValid: "That USDC authorisation is not valid yet.",
  CallerMustBePayee: "Only the market named in the authorisation can submit it.",
  InvalidSignature: "The signature does not match.",
  // graduation and claims
  GraduationPaused: "Graduation is paused.",
  GraduationRuleNotMet: "The pool does not meet its graduation rule yet.",
  BookNotReady: "This market's Kuru book is not ready, so it cannot graduate yet.",
  NothingToClaim: "There is nothing to claim.",
  NotGraduated: "The pool has not graduated, so there are no tokens to claim.",
  AlreadyGraduated: "This pool graduated: its stakers hold tokens instead of a pool claim.",
  BookExists: "This market already has a book.",
  BookMismatch: "That book does not match this market's YES token, USDC and book parameters.",
  CreationNotSupported: "Books cannot be created on this network; Kuru creates them.",
  // settlement
  NotClosed: "The market has not closed yet, so it cannot settle.",
  PastSettleDeadline: "The settlement deadline has passed. The only action left is void.",
  NotResolved: "Not resolvable yet: the source has no final answer for this market.",
  NotEarlyYes: "Only touch markets can be proved YES early.",
  NotExpired: "The settlement deadline has not passed, so the market cannot be voided yet.",
  MalformedEvidence: "The settlement evidence is not in the format the resolver expects.",
  EvidenceNotEmpty: "This market settles with empty evidence.",
  PhaseBoundary: "That Chainlink round is the last of its phase, so it cannot bracket the close.",
  RoundNotFound: "That Chainlink round does not exist.",
  RoundAfterTarget: "That Chainlink round was published after the close. The bracketing round is earlier.",
  RoundNotLastBeforeTarget:
    "That Chainlink round is not the last one before the close. The bracketing round is later.",
  RoundTooStale:
    "Chainlink's last round before the close is more than an hour old, so the resolver refuses. The market voids at its deadline.",
  NonPositivePrice: "The feed reported a price of zero or less, so the resolver refuses.",
  InsufficientFee: "Settling with a Pyth update needs MON for Pyth's update fee.",
  PythFeedMismatch: "That Pyth update is for a different price feed.",
  PythPublishTimeOutOfRange: "That Pyth update is not the first one published at or after the close.",
  RoundCarriedOver: "That Chainlink round carried an older answer forward, so it is not a new observation.",
  RoundOutsideWindow: "That Chainlink round was not updated inside the market's window.",
  NoTouch: "That Chainlink round did not reach the strike.",
  EventOutsideWindow: "That funding event is outside the market's window.",
  EventNotFinal: "That funding event is not final yet. Try again in a few blocks.",
  FundingReadFailed: "Perpl's funding history could not be read at that block.",
  NotAFundingEvent: "Perpl reports no funding event at that block.",
  NotOneInterval: "The funding event before that one is not exactly one interval earlier.",
  NotASpike: "That funding event did not charge more than the threshold.",
  // trading
  Slippage:
    "The price moved past the slippage limit, so nothing was traded. Check the new quote and try again.",
  SlippageExceeded:
    "The price moved past the slippage limit, so nothing was traded. Check the new quote and try again.",
  Expired: "The trade's deadline passed before it reached a block. Nothing was traded.",
  NotTradable: "This market is not trading on the book right now: it has not graduated, or it has closed.",
  InsufficientLiquidity: "The book does not hold enough orders for that amount. Try a smaller amount.",
  UnknownMarket: "This address is not a Hunch Book market.",
  AmountTooLarge: "That amount is too large.",
  MarketStateError: "Kuru has paused this book, so it cannot trade right now.",
  SizeError: "That amount is below the book's minimum order size.",
  PriceError: "The book refused the price.",
  TickSizeError: "That price is not on the book's tick grid.",
  // vault
  NotMergeable: "Sets merge from graduation until settlement, and after a void. Not now.",
  NotRedeemable: "Tokens redeem only after the market settles or voids.",
  LosingSide: "Only the winning side redeems. Losing tokens are worth nothing.",
  InsufficientPool: "The pool holds less than that.",
  SolvencyBreached: "The vault refused: the call would leave it short of what it owes.",
  // tokens
  ZeroAmount: "Enter an amount above zero.",
  FaucetLimit: "The test USDC faucet gives at most 10,000 USDC per call.",
  InsufficientBalance: "The wallet does not hold enough of that token.",
  InsufficientAllowance: "The contract is not approved to move that much yet. Approve first.",
  PermitExpired: "The permit signature has expired.",
  InvalidPermit: "The permit signature does not match.",
  // periphery
  NotOptedIn: "This holder has not opted in to auto-redeem.",
  NothingToRedeem: "There is nothing this holder has approved to redeem.",
  UnknownToken: "That token is not a Hunch Book outcome token.",
  PermitFailed: "The permit failed and the allowance is too small.",
  TipTooHigh: "The executor tip is above the 0.5% maximum.",
  BadTrigger: "The trigger price must be between 0 and 1 USDC.",
  BadExpiry: "The order's expiry must be in the future.",
  UnknownOrder: "There is no order with that id.",
  OrderNotOpen: "That order is not open: it was executed or cancelled.",
  OrderExpired: "That order has expired. It can only be cancelled.",
  NotTriggered: "The order's trigger price has not been reached.",
  NotOwner: "Only the order's owner can do that.",
  AlreadyBound: "This wallet already has an active referral binding.",
  SelfReferral: "A wallet cannot refer itself.",
  SignatureExpired: "The signature's deadline has passed.",
  AlreadyClaimed: "That reward was already claimed.",
  InvalidProof: "The Merkle proof does not match the epoch's root.",
  ExceedsTotal: "That claim would take the epoch past its total.",
  ClaimWindowClosed: "The epoch's claim deadline has passed.",
  ClaimWindowOpen: "The epoch's claim window is still open.",
  UnknownEpoch: "There is no epoch with that id.",
  OnlyFunder: "Only the distributor's funder can do that.",
  DeadlineTooSoon: "The claim deadline must be at least 7 days away.",
  NoObservations: "The oracle has no observations for this market yet. Poke it first.",
  InsufficientHistory: "The oracle does not hold that much history for this market yet.",
  ZeroPeriod: "Ask for a period above zero seconds.",
  // access
  OnlyGuardian: "Only the guardian can do that.",
  OnlyFactory: "Only the factory can do that.",
  OnlyMarket: "Only a market can do that.",
  OnlyFeeRecipient: "Only the fee recipient can do that.",
  Reentrancy: "The call re-entered a contract, which is refused.",
  ZeroAddress: "An address must not be zero.",
};

/** Decodes raw revert data against every known error. */
export function decodeRevert(data: Hex | undefined): { name: string; args: readonly unknown[] } | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_ERRORS_ABI as Abi, data });
    return { name: decoded.errorName, args: (decoded.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

// OpenZeppelin ERC-20 errors, by selector, for tokens that use them.
const BY_SELECTOR: Record<string, string> = {
  "0xfb8f41b2": "The contract is not approved to move that much yet. Approve first.",
  "0xe450d38c": "The wallet does not hold enough of that token.",
};

/** The custom error inside any viem error, if one can be decoded. */
export function revertOf(error: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  if (revert.data?.errorName) {
    return { name: revert.data.errorName, args: (revert.data.args ?? []) as readonly unknown[] };
  }
  return decodeRevert(revert.raw);
}

/** One sentence a person or an agent can act on, from any error a call can throw. */
export function describeError(error: unknown): string {
  if (error instanceof HunchError) return error.message;
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "The wallet rejected the request.";
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const decoded = revertOf(error);
      const byName = decoded ? ERROR_MESSAGES[decoded.name] : undefined;
      if (byName) return byName;
      const bySelector = revert.signature ? BY_SELECTOR[revert.signature] : undefined;
      if (bySelector) return bySelector;
      if (revert.reason) return `The contract refused: ${revert.reason}`;
      if (decoded) return `The contract refused with ${decoded.name}.`;
      return "The contract refused the call.";
    }
    if (/insufficient funds/i.test(error.message))
      return "The wallet does not hold enough MON to pay for gas.";
    return error.shortMessage;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

/**
 * The SDK's error: a plain-word message, the contract's error name when there is one (`code`), and the
 * original error as `cause`.
 */
export class HunchError extends Error {
  readonly code: string | undefined;
  constructor(message: string, options: { code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HunchError";
    this.code = options.code;
  }

  /** Wraps any error with its plain-word message and decoded error name. */
  static from(error: unknown): HunchError {
    if (error instanceof HunchError) return error;
    return new HunchError(describeError(error), { code: revertOf(error)?.name, cause: error });
  }
}
