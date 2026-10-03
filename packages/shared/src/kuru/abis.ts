// Kuru's spot contracts (github.com/Kuru-Labs/Kuru-contracts-dex-public), only the parts Hunch Book uses.
// Kuru's events carry no indexed fields: filter logs by the emitting contract's address.

const orderBookErrors = [
  { type: "error", name: "MarketStateError", inputs: [] },
  { type: "error", name: "PriceError", inputs: [] },
  { type: "error", name: "SizeError", inputs: [] },
  { type: "error", name: "TickSizeError", inputs: [] },
  { type: "error", name: "PostOnlyError", inputs: [] },
  { type: "error", name: "OnlyOwnerAllowedError", inputs: [] },
  { type: "error", name: "WrongOrderTypeCancel", inputs: [] },
  { type: "error", name: "OrderAlreadyFilledOrCancelled", inputs: [] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "InsufficientLiquidity", inputs: [] },
  { type: "error", name: "SlippageExceeded", inputs: [] },
  { type: "error", name: "Uint96Overflow", inputs: [] },
  { type: "error", name: "Uint32Overflow", inputs: [] },
] as const;

const marginAccountErrors = [
  { type: "error", name: "OnlyVerifiedMarketsAllowed", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "NativeAssetMismatch", inputs: [] },
  { type: "error", name: "ZeroAddressNotAllowed", inputs: [] },
  { type: "error", name: "ProtocolPaused", inputs: [] },
] as const;

/** One Kuru market (an ERC-1967 proxy over OrderBook). Prices in pricePrecision units, sizes in sizePrecision units. */
export const kuruOrderBookAbi = [
  {
    type: "function",
    name: "addBuyOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_price", type: "uint32" },
      { name: "size", type: "uint96" },
      { name: "_postOnly", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addSellOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_price", type: "uint32" },
      { name: "_size", type: "uint96" },
      { name: "_postOnly", type: "bool" },
    ],
    outputs: [],
  },
  {
    // Cancels first (a filled id is a no-op, an already cancelled id reverts), then places buys, then sells.
    type: "function",
    name: "batchUpdate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyPrices", type: "uint32[]" },
      { name: "buySizes", type: "uint96[]" },
      { name: "sellPrices", type: "uint32[]" },
      { name: "sellSizes", type: "uint96[]" },
      { name: "orderIdsToCancel", type: "uint40[]" },
      { name: "postOnly", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "batchCancelOrders",
    stateMutability: "nonpayable",
    inputs: [{ name: "_orderIds", type: "uint40[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "placeAndExecuteMarketBuy",
    stateMutability: "payable",
    inputs: [
      { name: "_quoteSize", type: "uint96" },
      { name: "_minAmountOut", type: "uint256" },
      { name: "_isMargin", type: "bool" },
      { name: "_isFillOrKill", type: "bool" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "placeAndExecuteMarketSell",
    stateMutability: "payable",
    inputs: [
      { name: "_size", type: "uint96" },
      { name: "_minAmountOut", type: "uint256" },
      { name: "_isMargin", type: "bool" },
      { name: "_isFillOrKill", type: "bool" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // 1e18 scale. An empty bid side reads as type(uint256).max and an empty ask side as 0.
    type: "function",
    name: "bestBidAsk",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
  {
    // Packed words: [block number][bid price, bid size]... [0][ask price, ask size]...
    type: "function",
    name: "getL2Book",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "getL2Book",
    stateMutability: "view",
    inputs: [
      { name: "_bidPricePoints", type: "uint32" },
      { name: "_askPricePoints", type: "uint32" },
    ],
    outputs: [{ name: "data", type: "bytes" }],
  },
  {
    type: "function",
    name: "getMarketParams",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "pricePrecision", type: "uint32" },
      { name: "sizePrecision", type: "uint96" },
      { name: "baseAsset", type: "address" },
      { name: "baseAssetDecimals", type: "uint256" },
      { name: "quoteAsset", type: "address" },
      { name: "quoteAssetDecimals", type: "uint256" },
      { name: "tickSize", type: "uint32" },
      { name: "minSize", type: "uint96" },
      { name: "maxSize", type: "uint96" },
      { name: "takerFeeBps", type: "uint256" },
      { name: "makerFeeBps", type: "uint256" },
    ],
  },
  {
    // A cancelled order is deleted (owner reads as zero). A filled order keeps its owner until cancelled.
    type: "function",
    name: "s_orders",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint40" }],
    outputs: [
      { name: "ownerAddress", type: "address" },
      { name: "size", type: "uint96" },
      { name: "prev", type: "uint40" },
      { name: "next", type: "uint40" },
      { name: "flippedId", type: "uint40" },
      { name: "price", type: "uint32" },
      { name: "flippedPrice", type: "uint32" },
      { name: "isBuy", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "s_buyPricePoints",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "head", type: "uint40" },
      { name: "tail", type: "uint40" },
    ],
  },
  {
    type: "function",
    name: "s_sellPricePoints",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "head", type: "uint40" },
      { name: "tail", type: "uint40" },
    ],
  },
  {
    type: "function",
    name: "s_orderIdCounter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint40" }],
  },
  {
    // 0 ACTIVE, 1 SOFT_PAUSED (cancels only), 2 HARD_PAUSED (nothing).
    type: "function",
    name: "marketState",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "event",
    name: "OrderCreated",
    anonymous: false,
    inputs: [
      { name: "orderId", type: "uint40", indexed: false },
      { name: "owner", type: "address", indexed: false },
      { name: "size", type: "uint96", indexed: false },
      { name: "price", type: "uint32", indexed: false },
      { name: "isBuy", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderCanceled",
    anonymous: false,
    inputs: [
      { name: "orderId", type: "uint40", indexed: false },
      { name: "owner", type: "address", indexed: false },
      { name: "price", type: "uint32", indexed: false },
      { name: "size", type: "uint96", indexed: false },
      { name: "isBuy", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrdersCanceled",
    anonymous: false,
    inputs: [
      { name: "orderId", type: "uint40[]", indexed: false },
      { name: "owner", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Trade",
    anonymous: false,
    inputs: [
      { name: "orderId", type: "uint40", indexed: false },
      { name: "makerAddress", type: "address", indexed: false },
      { name: "isBuy", type: "bool", indexed: false },
      { name: "price", type: "uint256", indexed: false },
      { name: "updatedSize", type: "uint96", indexed: false },
      { name: "takerAddress", type: "address", indexed: false },
      { name: "txOrigin", type: "address", indexed: false },
      { name: "filledSize", type: "uint96", indexed: false },
    ],
  },
  ...orderBookErrors,
  ...marginAccountErrors,
] as const;

/** Kuru's MarginAccount: limit orders draw from and settle into balances held here. */
export const kuruMarginAccountAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "_user", type: "address" },
      { name: "_token", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_amount", type: "uint256" },
      { name: "_token", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "batchWithdrawMaxTokens",
    stateMutability: "nonpayable",
    inputs: [{ name: "_tokens", type: "address[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getBalance",
    stateMutability: "view",
    inputs: [
      { name: "_user", type: "address" },
      { name: "_token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Deposit",
    anonymous: false,
    inputs: [
      { name: "owner", type: "address", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawal",
    anonymous: false,
    inputs: [
      { name: "owner", type: "address", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  ...marginAccountErrors,
] as const;

/** Kuru's Router: creates markets. Open to anyone on testnet; owner-only on mainnet. */
export const kuruRouterAbi = [
  {
    type: "function",
    name: "deployProxy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_type", type: "uint8" },
      { name: "_baseAssetAddress", type: "address" },
      { name: "_quoteAssetAddress", type: "address" },
      { name: "_sizePrecision", type: "uint96" },
      { name: "_pricePrecision", type: "uint32" },
      { name: "_tickSize", type: "uint32" },
      { name: "_minSize", type: "uint96" },
      { name: "_maxSize", type: "uint96" },
      { name: "_takerFeeBps", type: "uint256" },
      { name: "_makerFeeBps", type: "uint256" },
      { name: "_kuruAmmSpread", type: "uint96" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "function",
    name: "verifiedMarket",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "pricePrecision", type: "uint32" },
      { name: "sizePrecision", type: "uint96" },
      { name: "baseAssetAddress", type: "address" },
      { name: "baseAssetDecimals", type: "uint256" },
      { name: "quoteAssetAddress", type: "address" },
      { name: "quoteAssetDecimals", type: "uint256" },
      { name: "tickSize", type: "uint32" },
      { name: "minSize", type: "uint96" },
      { name: "maxSize", type: "uint96" },
      { name: "takerFeeBps", type: "uint256" },
      { name: "makerFeeBps", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "MarketRegistered",
    anonymous: false,
    inputs: [
      { name: "baseAsset", type: "address", indexed: false },
      { name: "quoteAsset", type: "address", indexed: false },
      { name: "market", type: "address", indexed: false },
      { name: "vaultAddress", type: "address", indexed: false },
      { name: "pricePrecision", type: "uint32", indexed: false },
      { name: "sizePrecision", type: "uint96", indexed: false },
      { name: "tickSize", type: "uint32", indexed: false },
      { name: "minSize", type: "uint96", indexed: false },
      { name: "maxSize", type: "uint96", indexed: false },
      { name: "takerFeeBps", type: "uint256", indexed: false },
      { name: "makerFeeBps", type: "uint256", indexed: false },
      { name: "kuruAmmSpread", type: "uint96", indexed: false },
    ],
  },
  { type: "error", name: "Unauthorized", inputs: [] },
  { type: "error", name: "BaseAndQuoteAssetSame", inputs: [] },
  { type: "error", name: "MarketTypeMismatch", inputs: [] },
  { type: "error", name: "InvalidTickSize", inputs: [] },
  { type: "error", name: "InvalidSizePrecision", inputs: [] },
  { type: "error", name: "InvalidPricePrecision", inputs: [] },
] as const;

/** Kuru's sentinels for an empty side in bestBidAsk(). */
export const KURU_EMPTY_BID = 2n ** 256n - 1n;
export const KURU_EMPTY_ASK = 0n;
/** bestBidAsk() prices are scaled to 1e18. */
export const KURU_BEST_PRICE_SCALE = 10n ** 18n;
