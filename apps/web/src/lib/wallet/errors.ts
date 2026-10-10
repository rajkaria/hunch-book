import {
  collateralVaultAbi,
  graduatorAbi,
  hunchBookFactoryAbi,
  hunchRouterAbi,
  kuruOrderBookAbi,
  marketAbi,
  testUsdcAbi,
} from "@hunch-book/shared";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Hex,
  parseAbi,
} from "viem";
import { isUserRejection } from "./network";

// Plain-word messages for every revert a person can hit from this app. A router trade can revert in the
// router, the vault, the market, the market's book (Kuru's, or Hunch Book's own, which uses Kuru v1's
// error names) or a token, so every call is simulated with all of their errors attached
// (KNOWN_ERRORS_ABI) and decoded by name here.

/** Errors defined in contracts but not in the interfaces the ABIs are generated from. */
const EXTRA_ERRORS = parseAbi([
  // HunchRouter
  "error InsufficientLiquidity()",
  "error AmountTooLarge()",
  "error UnexpectedFlashLoan()",
  "error OnlyVault()",
  "error Reentrancy()",
  "error CollateralMismatch()",
  // PriceAtTimeResolver
  "error MalformedEvidence()",
  "error PhaseBoundary(uint80 roundId)",
  "error RoundNotFound(uint80 roundId)",
  "error RoundAfterTarget(uint80 roundId, uint256 updatedAt, uint256 target)",
  "error RoundNotLastBeforeTarget(uint80 roundId, uint256 nextUpdatedAt, uint256 target)",
  "error RoundTooStale(uint80 roundId, uint256 updatedAt, uint256 target)",
  "error NonPositivePrice(int256 price)",
  "error InsufficientFee(uint256 fee, uint256 sent)",
  "error PythFeedMismatch()",
  "error PythPublishTimeOutOfRange(uint256 publishTime, uint256 target)",
  // PerplFundingResolver
  "error EvidenceNotEmpty()",
]);

type AbiError = Extract<Abi[number], { type: "error" }>;

const errorsOf = (abi: Abi): AbiError[] => abi.filter((item): item is AbiError => item.type === "error");

/** Every custom error the app's calls can surface, deduplicated by signature. */
export const KNOWN_ERRORS_ABI: AbiError[] = (() => {
  const seen = new Set<string>();
  const out: AbiError[] = [];
  for (const abi of [
    hunchRouterAbi,
    marketAbi,
    collateralVaultAbi,
    kuruOrderBookAbi,
    testUsdcAbi,
    graduatorAbi,
    hunchBookFactoryAbi,
    EXTRA_ERRORS,
  ] as Abi[]) {
    for (const e of errorsOf(abi)) {
      const key = `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
})();

/** Adds every known error to a call's ABI, so a revert from any contract it touches decodes by name. */
export function withKnownErrors(abi: Abi): Abi {
  return [...abi, ...KNOWN_ERRORS_ABI];
}

const BY_ERROR_NAME: Record<string, string> = {
  // staking
  StakeTooSmall: "That stake is below this market's minimum.",
  PoolCapExceeded: "That stake would take the pool over its cap.",
  WalletCapExceeded: "That stake would take your wallet over this market's limit.",
  WrongPhase: "The market has moved to another phase, so that is not possible now.",
  MarketNotOpen: "The market is not open.",
  CollateralCapExceeded: "The vault is at its beta limit for total USDC. Try a smaller amount later.",
  // graduation and claims
  GraduationPaused: "Graduation is paused.",
  GraduationRuleNotMet: "The pool does not meet its graduation rule yet.",
  BookNotReady: "This market's book is not ready, so it cannot graduate yet.",
  NothingToClaim: "There is nothing to claim.",
  NotGraduated: "The pool has not graduated, so there are no tokens to claim.",
  AlreadyGraduated: "This pool graduated: its stakers hold tokens instead of a pool claim.",
  // settlement
  NotClosed: "The market has not closed yet, so it cannot settle.",
  PastSettleDeadline: "The settlement deadline has passed. The only action left is void.",
  NotResolved: "Not resolvable yet: the source has no final answer for this market.",
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
  // trading
  Slippage:
    "The price moved past your slippage limit, so nothing was traded. Check the new quote and try again.",
  SlippageExceeded:
    "The price moved past your slippage limit, so nothing was traded. Check the new quote and try again.",
  Expired: "The trade's deadline passed before it reached a block. Nothing was traded. Try again.",
  NotTradable: "This market is not trading on the book right now: it has not graduated, or it has closed.",
  InsufficientLiquidity: "The book does not hold enough orders for that amount. Try a smaller amount.",
  UnknownMarket: "This address is not a Hunch Book market.",
  AmountTooLarge: "That amount is too large for the book.",
  MarketStateError:
    "The book is not matching orders right now (it is paused, or its market is not trading), so nothing was traded.",
  PostOnlyError:
    "That limit order would cross the book. Hunch Book's order book takes resting limit orders only; trade now with a market order instead.",
  SizeError: "That amount is below the book's minimum order size.",
  PriceError: "The book refused the price.",
  // vault
  NotMergeable: "Sets merge from graduation until settlement, and after a void. Not now.",
  NotRedeemable: "Tokens redeem only after the market settles or voids.",
  LosingSide: "Only the winning side redeems. Losing tokens are worth nothing.",
  // tokens
  ZeroAmount: "Enter an amount above zero.",
  FaucetLimit: "The faucet gives at most 10,000 test USDC per request.",
  InsufficientBalance: "Your wallet does not hold enough of that token.",
  InsufficientAllowance: "The contract is not approved to move that much yet. Approve first.",
};

// OpenZeppelin ERC-20 errors, by selector, in case a token uses them.
const BY_SELECTOR: Record<string, string> = {
  "0xfb8f41b2": "The contract is not approved to move that much yet. Approve first.",
  "0xe450d38c": "Your wallet does not hold enough of that token.",
};

/** The plain-word message for a custom error, by name. */
export function errorMessage(name: string | undefined): string | undefined {
  return name ? BY_ERROR_NAME[name] : undefined;
}

/** Decodes raw revert data against every known error. */
export function decodeRevert(data: Hex | undefined): { name: string; args: readonly unknown[] } | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_ERRORS_ABI, data });
    return { name: decoded.errorName, args: (decoded.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

/** The custom error name inside any viem error, if one can be decoded. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  return revert.data?.errorName ?? decodeRevert(revert.raw)?.name;
}

/** One sentence a person can act on, from any wallet or contract error. */
export function describeTxError(error: unknown): string {
  if (isUserRejection(error)) return "You rejected the request in your wallet.";
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? decodeRevert(revert.raw)?.name;
      const byName = errorMessage(name);
      if (byName) return byName;
      const bySelector = revert.signature ? BY_SELECTOR[revert.signature] : undefined;
      if (bySelector) return bySelector;
      if (revert.reason) return `The contract refused: ${revert.reason}`;
      if (name) return `The contract refused with ${name}.`;
    }
    if (/insufficient funds/i.test(error.message)) {
      return "Your wallet does not hold enough MON to pay for gas.";
    }
    return error.shortMessage;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}
