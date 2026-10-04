import { BaseError, ContractFunctionRevertedError } from "viem";
import { formatInt } from "../format";
import { describeTxError } from "../wallet/errors";

// Plain words for every revert creating a market can hit: the factory's own checks, the resolver's
// `validate` (bubbled up by the factory), the market's first stake, the vault and the token.

const num = (v: unknown): bigint | null =>
  typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : null;

/** One sentence for a revert by error name, or null for a name this flow does not know. */
export function describeCreateRevert(name: string, args: readonly unknown[] = []): string | null {
  switch (name) {
    // factory
    case "CreationIsPaused":
      return "Market creation is paused on this network right now. Existing markets are not affected.";
    case "UnknownTemplate":
      return "That template is not registered with the factory on this network.";
    case "MarketExists":
      return "This exact market already exists. Stake in it instead of creating a copy.";
    case "BadWindow":
      return "The window is not valid: the lock must still be ahead and the close must not come before it.";
    case "FirstStakeTooSmall":
    case "StakeTooSmall":
      return "Your first stake is below the minimum for a creator.";
    // market and vault, on the first stake
    case "WalletCapExceeded":
      return "That first stake is above the most one wallet can stake in a market.";
    case "PoolCapExceeded":
      return "That first stake is above the pool cap.";
    case "CollateralCapExceeded":
      return "The vault is at its beta limit for total USDC. Try a smaller first stake later.";
    // token
    case "InsufficientBalance":
    case "ERC20InsufficientBalance":
      return "Your wallet does not hold enough USDC for that first stake.";
    case "InsufficientAllowance":
    case "ERC20InsufficientAllowance":
      return "The Hunch Book vault is not approved to move that much of your USDC yet. Approve first.";
    // resolvers: shared
    case "NonCanonicalParams":
      return "The parameters are not in the one encoding the resolver accepts. Reload the page and try again.";
    case "DeadlineOverflow":
      return "The window is too far in the future.";
    // template 1: Perpl funding
    case "ExchangeVersionChanged": {
      const [major, minor, patch] = [num(args[0]), num(args[1]), num(args[2])];
      const version =
        major !== null && minor !== null && patch !== null ? ` (now v1.${major}.${minor}.${patch})` : "";
      return `Perpl upgraded its Exchange${version}, so this resolver no longer accepts new markets. A new template is needed first.`;
    }
    case "PerpNotListed":
    case "ContractDoesNotExist": {
      const id = num(args[0]);
      return `Perpl does not list perp ${id === null ? "with that id" : id.toString()} on this network.`;
    }
    case "PerpPaused":
      return "Perpl has paused this perp, so it cannot be used for a new market.";
    case "FundingNotStarted": {
      const start = num(args[1]);
      return start !== null && start > 0n
        ? `Funding on this perp starts at block ${formatInt(start)}, after your window starts. Pick a later start.`
        : "Funding on this perp has not started yet.";
    }
    case "ScalingExpMismatch":
      return "Perpl changed this perp's funding units since the page loaded. Reload the page to read them again.";
    case "StartBlockNotInFuture": {
      const start = num(args[0]);
      const current = num(args[1]);
      return start !== null && current !== null
        ? `The window start (block ${formatInt(start)}) has already passed: the chain is at block ${formatInt(current)}. Pick a later start.`
        : "The window start has already passed. Pick a later start.";
    }
    case "WindowTooShort": {
      const interval = num(args[2]);
      return `The window must cover at least one funding interval${
        interval !== null ? ` (${formatInt(interval)} blocks)` : ""
      }. Pick a later end.`;
    }
    // template 2: price at a time
    case "PythNotConfigured":
      return "Pyth is not set up for this resolver on this network. Pick a Chainlink feed.";
    case "UnknownSource":
      return "The resolver does not know that source.";
    case "FeedNotAllowed":
      return "The resolver does not accept that Chainlink feed.";
    case "PythIdNotAllowed":
      return "The resolver does not accept that Pyth price id.";
    case "UnusedFieldSet":
      return "A field for the other price source is set. Reload the page and try again.";
    case "StrikeNotPositive":
      return "The price level must be above zero.";
    case "LockNotInFuture":
      return "The lock time has already passed. Pick a later lock.";
    case "CloseBeforeLock":
      return "The close must be at or after the lock.";
    // template 3: price touch
    case "UnknownDirection":
      return "A touch is either at or above the level, or at or below it.";
    case "StartBeforeLock":
      return "Staking must stop at or before the window starts.";
    case "EmptyWindow":
      return "The window must end after it starts.";
    case "WindowTooLong":
      return args.length === 3
        ? "A spike window can be at most 31 days long."
        : "A touch window can be at most 31 days long.";
    // template 5: price range
    case "LowerNotPositive":
      return "The bottom of the range must be above zero.";
    case "EmptyRange":
      return "The top of the range must be above the bottom.";
    // template 6: parlay
    case "LegCount":
      return "A parlay has 2 to 5 legs.";
    case "LegsNotSorted":
      return "The legs are not in the one order the resolver accepts, or a market appears twice. Reload and pick again.";
    case "NotAHunchMarket":
      return "One of the legs is not a market of this factory.";
    case "LegFinished":
      return "One of the legs has already settled or voided, so it cannot be part of a new parlay.";
    case "LockAfterLeg":
      return "The parlay must lock at or before every leg can lock. Pick an earlier lock.";
    // template 7: snapshot
    case "UnknownComparator":
      return "Pick above, at or above, below, or at or below.";
    case "SnapshotWindowOutOfRange":
      return "The snapshot window is 1 to 30 minutes long.";
    case "SourceCallFailed":
    case "SourceReturnTooShort":
      return "The resolver cannot read this source right now, so it takes no new markets on it. Try again later.";
    case "ValueOutOfRange":
      return "The source returned a value the resolver cannot hold, so it takes no new markets on it.";
    case "ValueStale":
      return "The source's value is older than the resolver accepts right now. Try again in a minute.";
    case "GuardCallFailed":
    case "SourceChanged":
      return "Perpl changed since this resolver was deployed (an upgrade, a pause or a relisted perp), so it takes no new markets on this source.";
    default:
      return null;
  }
}

/** The decoded revert inside any viem error, if there is one. */
export function revertOf(error: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError) || !revert.data?.errorName) return null;
  return { name: revert.data.errorName, args: (revert.data.args as readonly unknown[] | undefined) ?? [] };
}

/** One sentence a person can act on, for any error while previewing or creating a market. */
export function describeCreateError(error: unknown): string {
  const revert = revertOf(error);
  if (revert) {
    const text = describeCreateRevert(revert.name, revert.args);
    if (text) return text;
  }
  return describeTxError(error);
}
