// External read-only ABIs the maker needs beyond Kuru's (packages/shared) and Hunch Book's own.

/** Perpl's Exchange (PerplFoundation/dex-sdk ABI), only the funding reads. */
export const perplExchangeAbi = [
  {
    // Cumulative funding as of the last funding event at or before `blockNumber`. Rising = longs paid.
    type: "function",
    name: "getFundingSumAtBlock",
    stateMutability: "view",
    inputs: [
      { name: "perpId", type: "uint256" },
      { name: "blockNumber", type: "uint256" },
    ],
    outputs: [
      { name: "fundingSumPNS", type: "int48" },
      { name: "fundingEventBlock", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getFundingInterval",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "fundingInterval", type: "uint256" }],
  },
  {
    type: "function",
    name: "getPerpetualInfoV2",
    stateMutability: "view",
    inputs: [{ name: "perpId", type: "uint256" }],
    outputs: [
      {
        name: "perpetualInfo",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "priceDecimals", type: "uint256" },
          { name: "lotDecimals", type: "uint256" },
          { name: "linkFeedId", type: "bytes32" },
          { name: "priceTolPer100K", type: "uint256" },
          { name: "marginTol", type: "uint256" },
          { name: "marginTolDecimals", type: "uint256" },
          { name: "refPriceMaxAgeSec", type: "uint256" },
          { name: "positionBalanceCNS", type: "uint256" },
          { name: "insuranceBalanceCNS", type: "uint256" },
          { name: "markPNS", type: "uint256" },
          { name: "markTimestamp", type: "uint256" },
          { name: "lastPNS", type: "uint256" },
          { name: "lastTimestamp", type: "uint256" },
          { name: "oraclePNS", type: "uint256" },
          { name: "oracleTimestampSec", type: "uint256" },
          { name: "longOpenInterestLNS", type: "uint256" },
          { name: "shortOpenInterestLNS", type: "uint256" },
          { name: "fundingStartBlock", type: "uint256" },
          { name: "fundingRatePct100k", type: "int16" },
          { name: "absFundingClampPctPer100K", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "basePricePNS", type: "uint256" },
          { name: "maxBidPriceONS", type: "uint256" },
          { name: "minBidPriceONS", type: "uint256" },
          { name: "maxAskPriceONS", type: "uint256" },
          { name: "minAskPriceONS", type: "uint256" },
          { name: "numOrders", type: "uint256" },
          { name: "ignOracle", type: "bool" },
          { name: "fundingSumScalingExp", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/** Chainlink AggregatorV3Interface (the proxy). Round ids are (phaseId << 64) | aggregatorRoundId. */
export const chainlinkAggregatorAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "description",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;
