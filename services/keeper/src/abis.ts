import { hunchBookFactoryAbi, marketAbi } from "@hunch-book/shared";
import { parseAbi } from "viem";

// External and extra ABIs the keeper needs beyond Hunch Book's generated ones in packages/shared.

/** Pyth's onchain contract: only the fee read (contracts/src/interfaces/external/IPyth.sol). */
export const pythAbi = parseAbi([
  "function getUpdateFee(bytes[] updateData) view returns (uint256 feeAmount)",
]);

/** A Chainlink aggregator proxy: the two round reads (AggregatorV3Interface). */
export const chainlinkFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Kuru's Router: the address `deployProxy` would use (contracts/src/interfaces/external/IKuruRouter.sol). */
export const kuruRouterComputeAbi = parseAbi([
  "function computeAddress(address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread, address oldImplementation, bool old) view returns (address proxy)",
]);

/**
 * Custom errors of the resolvers (contracts/src/resolvers). `settle` and `proveYes` bubble them up, so a
 * failed simulation can be logged by name ("RoundTooStale", "NotASpike") instead of as raw bytes.
 */
export const resolverErrorsAbi = parseAbi([
  // Template 3, touch
  "error RoundCarriedOver(uint80 roundId, uint80 answeredInRound)",
  "error RoundOutsideWindow(uint80 roundId, uint256 updatedAt, uint64 startTime, uint64 endTime)",
  "error NoTouch(uint80 roundId, int256 priceE8, int256 strikeE8)",
  // Template 4, funding spike
  "error EventOutsideWindow(uint64 eventBlock, uint64 startBlock, uint64 endBlock)",
  "error EventNotFinal(uint64 eventBlock, uint256 currentBlock)",
  "error FundingReadFailed(uint256 blockNumber)",
  "error NotAFundingEvent(uint64 eventBlock, uint256 reportedEventBlock)",
  "error NotOneInterval(uint64 eventBlock, uint256 previousEventBlock, uint256 fundingInterval)",
  "error NotASpike(uint64 eventBlock, int256 increment, int256 threshold)",
  // Templates 1, 2, 5, 6
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
  "error PythNotConfigured()",
  "error FeedNotAllowed(address feed)",
  "error PythIdNotAllowed(bytes32 id)",
  "error UnknownSource(uint8 source)",
  "error EvidenceNotEmpty()",
  "error DeadlineOverflow()",
]);

/** The market's ABI plus the resolver errors, for decoding what a `settle` simulation says. */
export const marketWithResolverErrorsAbi = [...marketAbi, ...resolverErrorsAbi] as const;

/** The factory's MarketCreated event, for finding each market's creation block. */
export const marketCreatedEvent = (() => {
  const item = hunchBookFactoryAbi.find((x) => x.type === "event" && x.name === "MarketCreated");
  if (!item) throw new Error("MarketCreated is missing from hunchBookFactoryAbi");
  return item;
})();

/** The market's Staked event, for finding stakers. */
export const stakedEvent = (() => {
  const item = marketAbi.find((x) => x.type === "event" && x.name === "Staked");
  if (!item) throw new Error("Staked is missing from marketAbi");
  return item;
})();
