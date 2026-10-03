// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// `IKuruOrderBook.getMarketParams()` return values, in order. All fields are static, so the ABI
/// encoding of the 11 return values is also the encoding of this struct (decode the raw return data).
struct KuruMarketParams {
    uint32 pricePrecision;
    uint96 sizePrecision;
    address baseAsset;
    uint256 baseAssetDecimals;
    address quoteAsset;
    uint256 quoteAssetDecimals;
    uint32 tickSize;
    uint96 minSize;
    uint96 maxSize;
    uint256 takerFeeBps;
    uint256 makerFeeBps;
}

/// `IKuruOrderBook.getVaultParams()` return values, in order (decode the raw return data).
struct KuruVaultParams {
    address kuruAmmVault;
    uint256 vaultBestBid;
    uint96 bidPartiallyFilledSize;
    uint256 vaultBestAsk;
    uint96 askPartiallyFilledSize;
    uint96 vaultBidOrderSize;
    uint96 vaultAskOrderSize;
    uint96 kuruAmmSpread;
}

/// The parts of a Kuru spot order book (one YES/USDC market) that Hunch Book uses.
/// Signatures match Kuru-contracts-dex-public `OrderBook.sol` and the contracts deployed on Monad
/// testnet and mainnet (selectors and event topics checked against the deployed bytecode).
///
/// Units. A price is quote per one base unit, scaled by `pricePrecision`, and must be a multiple of
/// `tickSize`. A size is base scaled by `sizePrecision`. Hunch books use pricePrecision = 1e6 and
/// sizePrecision = 1e6 with 6-decimal YES and USDC, so prices and sizes are plain token base units.
interface IKuruOrderBook {
    /// A resting limit order was created. Kuru indexes no event fields, so readers filter by address.
    event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy);
    /// A taker filled `filledSize` against a maker order (`orderId` 0 = the book's AMM vault).
    /// `isBuy` is the taker's side; `price` is scaled to 1e18.
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );
    event OrdersCanceled(uint40[] orderId, address owner);

    /// Spends `_quoteSize` (in pricePrecision units) on base. Wallet path (`_isMargin` = false): pulls
    /// the quote with transferFrom from the caller (approve this book), sends base to the caller, and
    /// refunds any unspent quote unless `_isFillOrKill`. Reverts `SlippageExceeded()` if the base
    /// credited (after the taker fee, in base decimals) is below `_minAmountOut`.
    function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);

    /// Sells `_size` (in sizePrecision units) of base. Wallet path as above, with roles swapped.
    function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);

    /// Limit orders always settle through Kuru's MarginAccount (deposit first).
    function addBuyOrder(uint32 _price, uint96 size, bool _postOnly) external;
    function addSellOrder(uint32 _price, uint96 size, bool _postOnly) external;
    /// Cancels first, then places buys, then sells.
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool postOnly
    ) external;

    function s_orderIdCounter() external view returns (uint40);

    /// Best bid and ask scaled to 1e18. Empty bid reads as type(uint256).max, empty ask as 0.
    function bestBidAsk() external view returns (uint256, uint256);

    /// Resting orders only (not the AMM vault), as packed 32-byte words:
    /// [block number] [bid price, bid size]... [0] [ask price, ask size]...
    /// Bids best (highest) first, asks best (lowest) first; prices in pricePrecision units,
    /// sizes in sizePrecision units summed over every order at that price.
    function getL2Book() external view returns (bytes memory);
    /// Same, limited to the best `_bidPricePoints` bid levels and `_askPricePoints` ask levels.
    function getL2Book(uint32 _bidPricePoints, uint32 _askPricePoints) external view returns (bytes memory);

    /// See `KuruMarketParams` for the field order.
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256);

    /// See `KuruVaultParams` for the field order.
    function getVaultParams() external view returns (address, uint256, uint96, uint256, uint96, uint96, uint96, uint96);
}
