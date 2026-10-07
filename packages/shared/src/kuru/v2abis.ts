// Kuru v2 (AccountCore, SpotRouter, OrderBook, WithdrawalLimiter): the functions and events Hunch Book
// reads or calls, written from the deployed contracts' signatures (ABI of Kuru's "auditFixes" commit).
// No Kuru code is copied. docs/PROTOCOL.md §8.1 (Kuru v2).

const order = {
  type: "tuple[]",
  name: "orders",
  components: [
    { name: "side", type: "uint8" },
    { name: "quantity", type: "uint96" },
    { name: "price", type: "uint32" },
    { name: "tif", type: "uint8" },
    { name: "executionInstruction", type: "uint8" },
    { name: "minSizeAfterBlock", type: "uint32" },
  ],
} as const;

const swapResult = {
  type: "tuple",
  name: "result",
  components: [
    { name: "amountInUsed", type: "uint128" },
    { name: "amountOut", type: "uint128" },
  ],
} as const;

export const kuruV2OrderBookAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "userId", type: "uint40" },
      { name: "isBuy", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "minAmountOut", type: "uint128" },
      { name: "deadline", type: "uint64" },
    ],
    outputs: [swapResult],
  },
  {
    type: "function",
    name: "estimateSwap",
    stateMutability: "view",
    inputs: [
      { name: "userId", type: "uint40" },
      { name: "isBuy", type: "bool" },
      { name: "amountIn", type: "uint128" },
    ],
    outputs: [swapResult],
  },
  {
    type: "function",
    name: "bestBidAsk",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "bid", type: "uint32" },
      { name: "ask", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "getL2Book",
    stateMutability: "view",
    inputs: [{ name: "levels", type: "uint256" }],
    outputs: [
      { name: "bidPrices", type: "uint32[]" },
      { name: "bidSizes", type: "uint96[]" },
      { name: "askPrices", type: "uint32[]" },
      { name: "askSizes", type: "uint96[]" },
    ],
  },
  {
    type: "function",
    name: "getMarketParams",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "pricePrecision", type: "uint32" },
      { name: "sizePrecision", type: "uint96" },
      { name: "tickSize", type: "uint32" },
      { name: "minQuoteNotional", type: "uint96" },
      { name: "maxQuoteNotional", type: "uint96" },
      { name: "takerFeePps", type: "uint256" },
      { name: "makerFeePps", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "lastTradeObservation",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "priceX8", type: "uint64" },
      { name: "timestamp", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "getOrderId",
    stateMutability: "view",
    inputs: [
      { name: "userId", type: "uint40" },
      { name: "slotIdx", type: "uint8" },
    ],
    outputs: [{ name: "orderId", type: "uint64" }],
  },
  {
    type: "function",
    name: "makerLockedReserves",
    stateMutability: "view",
    inputs: [{ name: "userId", type: "uint40" }],
    outputs: [
      { name: "baseReserved", type: "uint256" },
      { name: "quoteReserved", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "accountCore",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "baseToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "quoteToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "pricePrecision",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "sizePrecision",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint96" }],
  },
  {
    type: "function",
    name: "tickSize",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "passiveSpreadTicks",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "minQuoteNotional",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint96" }],
  },
  {
    type: "function",
    name: "maxQuoteNotional",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint96" }],
  },
  {
    type: "function",
    name: "takerFeePps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "makerFeePps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "marketState",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "batch",
    stateMutability: "nonpayable",
    inputs: [{ name: "userId", type: "uint40" }, order, { name: "cancelSlotIdxs", type: "uint8[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "replaceBySlotPacked",
    stateMutability: "nonpayable",
    inputs: [
      { name: "userId", type: "uint40" },
      { name: "packedOps", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelAllOrders",
    stateMutability: "nonpayable",
    inputs: [{ name: "userId", type: "uint40" }],
    outputs: [],
  },
  {
    type: "event",
    name: "SpotSwap",
    anonymous: false,
    inputs: [
      { name: "userId", type: "uint40", indexed: false },
      { name: "executor", type: "address", indexed: false },
      { name: "isBuy", type: "bool", indexed: false },
      { name: "amountInUsed", type: "uint128", indexed: false },
      { name: "amountOut", type: "uint128", indexed: false },
      { name: "minAmountOut", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BookUpdatesPacked",
    anonymous: false,
    inputs: [
      { name: "accountId", type: "uint40", indexed: false },
      { name: "executor", type: "address", indexed: false },
      { name: "clientOrderId", type: "bytes32", indexed: false },
      { name: "packedUpdates", type: "bytes", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarketStateUpdated",
    anonymous: false,
    inputs: [
      { name: "previousState", type: "uint8", indexed: false },
      { name: "newState", type: "uint8", indexed: false },
    ],
  },
] as const;

export const kuruV2AccountCoreAbi = [
  {
    type: "function",
    name: "ensureRootAccount",
    stateMutability: "nonpayable",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint40" }],
  },
  {
    type: "function",
    name: "rootAccountIdOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint40" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "rootAccountId", type: "uint40" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "rootAccountId", type: "uint40" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getBalance",
    stateMutability: "view",
    inputs: [
      { name: "accountId", type: "uint40" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getSpotReservedBalance",
    stateMutability: "view",
    inputs: [
      { name: "accountId", type: "uint40" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "spotTokenConfigs",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "decimals", type: "uint8" },
      { name: "enabled", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "verifiedSpotOrderBook",
    stateMutability: "view",
    inputs: [{ name: "book", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "withdrawalLimiter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "withdrawalsFrozen",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "protocolPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "AccountRegistered",
    anonymous: false,
    inputs: [
      { name: "accountId", type: "uint40", indexed: false },
      { name: "rootAccountId", type: "uint40", indexed: false },
      { name: "rootOwner", type: "address", indexed: false },
      { name: "subaccountSeq", type: "uint16", indexed: false },
    ],
  },
] as const;

export const kuruV2SpotRouterAbi = [
  {
    type: "function",
    name: "computeAddress",
    stateMutability: "view",
    inputs: [
      { name: "baseToken", type: "address" },
      { name: "quoteToken", type: "address" },
      { name: "sizePrecision", type: "uint96" },
      { name: "pricePrecision", type: "uint32" },
      { name: "tickSize", type: "uint32" },
      { name: "passiveSpreadTicks", type: "uint32" },
      { name: "minQuoteNotional", type: "uint96" },
      { name: "maxQuoteNotional", type: "uint96" },
      { name: "takerFeePps", type: "uint256" },
      { name: "makerFeePps", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "verifiedSpotMarket",
    stateMutability: "view",
    inputs: [{ name: "book", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "whitelistedSpotTokens",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const kuruV2WithdrawalLimiterAbi = [
  {
    type: "function",
    name: "priceSource",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "previewWithdrawal",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "requiredUsd36", type: "uint256" },
      { name: "availableUsd36", type: "uint256" },
      { name: "withinLimit", type: "bool" },
    ],
  },
] as const;

/** Kuru v2 `bestBidAsk()` empty-side values (either may appear on either side). */
export const KURU_V2_EMPTY_LOW = 0n;
export const KURU_V2_EMPTY_HIGH = 2n ** 32n - 1n;
/** Fees are parts per 10^7. */
export const KURU_V2_PPS = 10_000_000n;
/** At most 62 resting orders per maker per book; slots 0 to 61. */
export const KURU_V2_MAX_SLOTS = 62;
/** Order fields. */
export const KuruV2Side = { buy: 0, sell: 1 } as const;
export const KuruV2Tif = { gtc: 0, ioc: 1, fok: 2 } as const;
export const KuruV2Exec = { none: 0, postOnly: 1 } as const;
/** `marketState()`: 0 active, 1 soft pause (cancels and withdrawals only), 2 hard pause. */
export const KuruV2MarketState = { active: 0, softPause: 1, hardPause: 2 } as const;
