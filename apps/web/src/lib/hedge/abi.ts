// Read-only ABI for Perpl's Exchange, for the hedge assistant. The interface the resolvers use
// (contracts/src/interfaces/external/IPerplExchange.sol) has no position getters, so these come from
// Perpl's published ABI (PerplFoundation/dex-sdk, crates/sdk/abi/dex/Exchange.json, contract v1.7.5).
// Every entry was checked against the live testnet Exchange: getAccountByAddr and getPositionV2
// decode, and a position's premiumPnlCNS equals the funding computed from getFundingSumAtBlock.

const positionInfoV2 = {
  name: "positionInfo",
  type: "tuple",
  components: [
    { name: "accountId", type: "uint256" },
    { name: "nextNodeId", type: "uint256" },
    { name: "prevNodeId", type: "uint256" },
    // PositionEnum: 0 long, 1 short.
    { name: "positionType", type: "uint8" },
    { name: "depositCNS", type: "uint256" },
    { name: "pricePNS", type: "uint256" },
    { name: "lotLNS", type: "uint256" },
    { name: "entryBlock", type: "uint256" },
    { name: "pnlCNS", type: "int256" },
    { name: "deltaPnlCNS", type: "int256" },
    // Funding received (+) or paid (-) since entry, in collateral units.
    { name: "premiumPnlCNS", type: "int256" },
    { name: "priceResiduePNSQ16", type: "uint256" },
  ],
} as const;

export const perplReadAbi = [
  {
    type: "function",
    name: "getAccountByAddr",
    stateMutability: "view",
    inputs: [{ name: "accountAddress", type: "address" }],
    outputs: [
      {
        name: "accountInfo",
        type: "tuple",
        components: [
          { name: "accountId", type: "uint256" },
          { name: "balanceCNS", type: "uint256" },
          { name: "lockedBalanceCNS", type: "uint256" },
          { name: "frozen", type: "uint8" },
          { name: "accountAddr", type: "address" },
          {
            // Bit (id % 256) of bank (id / 256 + 1) is set when the account holds a position in perp id.
            name: "positions",
            type: "tuple",
            components: [
              { name: "bank1", type: "uint256" },
              { name: "bank2", type: "uint256" },
              { name: "bank3", type: "uint256" },
              { name: "bank4", type: "uint256" },
            ],
          },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getPositionV2",
    stateMutability: "view",
    inputs: [
      { name: "perpId", type: "uint256" },
      { name: "accountId", type: "uint256" },
    ],
    outputs: [
      positionInfoV2,
      { name: "markPricePNS", type: "uint256" },
      { name: "markPriceValid", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getExchangeInfo",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "balanceCNS", type: "uint256" },
      { name: "protocolBalanceCNS", type: "uint256" },
      { name: "recycleBalanceCNS", type: "uint256" },
      { name: "collateralDecimals", type: "uint256" },
      { name: "collateralToken", type: "address" },
      { name: "verifierProxy", type: "address" },
    ],
  },
  {
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
