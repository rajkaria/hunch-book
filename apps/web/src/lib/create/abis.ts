import { hunchBookFactoryAbi, resolverAbi } from "@hunch-book/shared";
import { type Abi, parseAbi } from "viem";
import { withKnownErrors } from "../wallet/errors";

// ABI pieces the create flow needs beyond the generated interfaces: the resolvers' own errors and
// views (the generated `resolverAbi` is the bare IResolver interface), Chainlink's latest round,
// Pyth's last onchain price, and the token errors of Hunch Book's test USDC.

/** Every revert a resolver's `validate` can raise, for templates 1 to 7. */
export const resolverErrorsAbi = parseAbi([
  // shared
  "error NonCanonicalParams()",
  "error DeadlineOverflow()",
  // template 1, Perpl funding (PerplFundingResolver)
  "error ExchangeVersionChanged(uint256 major, uint256 minor, uint256 patch)",
  "error PerpNotListed(uint256 perpId)",
  "error PerpPaused(uint256 perpId)",
  "error FundingNotStarted(uint256 perpId, uint256 fundingStartBlock, uint64 startBlock)",
  "error ScalingExpMismatch(uint256 expected, uint256 actual)",
  "error StartBlockNotInFuture(uint64 startBlock, uint256 currentBlock)",
  "error WindowTooShort(uint64 startBlock, uint64 endBlock, uint256 fundingInterval)",
  // template 2, price at a time (PriceAtTimeResolver)
  "error PythNotConfigured()",
  "error UnknownSource(uint8 source)",
  "error FeedNotAllowed(address feed)",
  "error PythIdNotAllowed(bytes32 id)",
  "error UnusedFieldSet()",
  "error StrikeNotPositive(int256 strikeE8)",
  "error LockNotInFuture(uint64 lockTime, uint256 currentTime)",
  "error CloseBeforeLock(uint64 lockTime, uint64 closeTime)",
  // template 3, price touch (ChainlinkTouchResolver)
  "error UnknownDirection(uint8 direction)",
  "error StartBeforeLock(uint64 lockTime, uint64 startTime)",
  "error EmptyWindow(uint64 startTime, uint64 endTime)",
  "error WindowTooLong(uint64 startTime, uint64 endTime)",
  // template 4, funding spike (PerplFundingSpikeResolver)
  "error WindowTooLong(uint64 startBlock, uint64 endBlock, uint256 maxBlocks)",
  // template 5, price range (PriceRangeResolver)
  "error LowerNotPositive(int256 lowerE8)",
  "error EmptyRange(int256 lowerE8, int256 upperE8)",
  // template 6, parlay (MarketOutcomeResolver)
  "error LegCount(uint256 count, uint256 minimum, uint256 maximum)",
  "error LegsNotSorted(address leg)",
  "error NotAHunchMarket(address leg)",
  "error LegFinished(address leg)",
  "error LockAfterLeg(address leg, uint64 lockTime, uint256 legEarliestLock)",
  // template 7, snapshot (SnapshotResolver)
  "error UnknownSource(uint16 sourceId)",
  "error UnknownComparator(uint8 comparator)",
  "error SnapshotWindowOutOfRange(uint32 snapshotWindow)",
  "error SourceCallFailed(uint16 sourceId)",
  "error SourceReturnTooShort(uint16 sourceId)",
  "error ValueOutOfRange(uint16 sourceId, uint256 raw)",
  "error ValueStale(uint16 sourceId, uint256 updatedAt, uint256 maxAge)",
  "error GuardCallFailed(uint16 sourceId)",
  "error SourceChanged(uint16 sourceId)",
  // Perpl's own revert for an unknown perp id
  "error ContractDoesNotExist(uint256 perpId)",
]);

/** Solady ERC-20 errors (Hunch Book's test USDC) and OpenZeppelin's (Circle-style tokens). */
export const tokenErrorsAbi = parseAbi([
  "error InsufficientBalance()",
  "error InsufficientAllowance()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

/** IResolver plus every resolver error, so `validate` reverts decode by name. */
export const resolverWithErrorsAbi = [...resolverAbi, ...resolverErrorsAbi] as unknown as Abi;

/**
 * The factory's ABI plus every error `createMarket` can bubble up: the resolver's `validate`, and
 * (through the app's known errors) the market's first stake, the vault's deposit and the token.
 */
export const createMarketAbi: Abi = withKnownErrors([
  ...hunchBookFactoryAbi,
  ...resolverErrorsAbi,
  ...tokenErrorsAbi,
] as unknown as Abi);

/** The price resolvers' allowlist views (not part of IResolver). The touch resolver has no Pyth ids. */
export const priceResolverViewsAbi = parseAbi([
  "function feeds() view returns (address[])",
  "function pythIds() view returns (bytes32[])",
  "function pythLabel(bytes32 id) view returns (string)",
]);

/** Template 4's challenge period, in blocks (fixed when the resolver was deployed). */
export const spikeResolverViewsAbi = parseAbi(["function challengeBlocks() view returns (uint256)"]);

/** Template 6's block-time assumption for block-clock legs, in milliseconds. */
export const parlayResolverViewsAbi = parseAbi(["function fastBlockTimeMs() view returns (uint256)"]);

/** The parts of a Chainlink proxy the create flow reads for the current price. */
export const chainlinkLatestAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Pyth's last price stored onchain, without a freshness check (the app shows its age instead). */
export const pythPriceAbi = parseAbi([
  "struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }",
  "function getPriceUnsafe(bytes32 id) view returns (Price price)",
]);
