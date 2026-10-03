import { BaseError, ContractFunctionRevertedError } from "viem";
import { isUserRejection } from "./network";

// Plain-word messages for the reverts a person can hit from this app.
const BY_ERROR_NAME: Record<string, string> = {
  StakeTooSmall: "That stake is below this market's minimum.",
  PoolCapExceeded: "That stake would take the pool over its cap.",
  WalletCapExceeded: "That stake would take your wallet over this market's limit.",
  WrongPhase: "The market is not taking stakes any more.",
  MarketNotOpen: "The market is not open.",
  CollateralCapExceeded: "The vault is at its beta limit for total USDC. Try a smaller amount later.",
  GraduationPaused: "Graduation is paused.",
  NothingToClaim: "There is nothing to claim.",
  ZeroAmount: "Enter an amount above zero.",
};

// OpenZeppelin ERC-20 errors, by selector, since the market ABI does not include them.
const BY_SELECTOR: Record<string, string> = {
  "0xfb8f41b2": "The vault is not approved to move that much of your USDC yet. Approve first.",
  "0xe450d38c": "Your wallet does not hold enough USDC.",
};

/** One sentence a person can act on, from any wallet or contract error. */
export function describeTxError(error: unknown): string {
  if (isUserRejection(error)) return "You rejected the request in your wallet.";
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const byName = name ? BY_ERROR_NAME[name] : undefined;
      if (byName) return byName;
      const bySelector = revert.signature ? BY_SELECTOR[revert.signature] : undefined;
      if (bySelector) return bySelector;
      if (revert.reason) return `The contract refused: ${revert.reason}`;
      if (name) return `The contract refused with ${name}.`;
    }
    return error.shortMessage;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}
