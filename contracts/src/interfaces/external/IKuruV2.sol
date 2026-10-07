// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// The parts of Kuru's v2 exchange that Hunch Book uses, written from the function signatures of the
/// deployed contracts (Monad testnet, ABI of Kuru's "auditFixes" commit). No Kuru code is copied.
///
/// v2 differs from v1 in three ways that matter here:
/// - Balances live in AccountCore under numeric account ids (uint40). A contract trades by depositing
///   into its own account, calling `swap` on a book, and withdrawing; there is no wallet path.
/// - Books are created by Kuru governance (`SpotRouter.deploySpotMarket`). Each token must first be
///   whitelisted, enabled in AccountCore and given a price source in the WithdrawalLimiter.
/// - Prices are uint32 in `pricePrecision` units (Hunch books: 1e6 = 1 USDC per YES), and fees are in
///   pps (parts per 10^7, so 7000 = 0.07%).

/// Result of `IKuruSpotOrderBook.swap` and `estimateSwap`: input actually spent and output credited
/// (after the taker fee), both in token base units.
struct KuruSwapResult {
    uint128 amountInUsed;
    uint128 amountOut;
}

/// Kuru v2 market factory and token whitelist.
interface IKuruSpotRouter {
    /// Governance only. Deploys a book; the address is `computeAddress` of the same arguments.
    function deploySpotMarket(
        address baseToken,
        address quoteToken,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint32 passiveSpreadTicks,
        uint96 minQuoteNotional,
        uint96 maxQuoteNotional,
        uint256 takerFeePps,
        uint256 makerFeePps
    ) external returns (address proxy);

    function computeAddress(
        address baseToken,
        address quoteToken,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint32 passiveSpreadTicks,
        uint96 minQuoteNotional,
        uint96 maxQuoteNotional,
        uint256 takerFeePps,
        uint256 makerFeePps
    ) external view returns (address);

    /// True for every book this router deployed.
    function verifiedSpotMarket(address book) external view returns (bool);
    function whitelistedSpotTokens(address token) external view returns (bool);
    /// Governance only. State 0 = active, 1 = soft pause (no swaps or new orders; cancels and
    /// withdrawals work), 2 = hard pause.
    function toggleSpotMarkets(address[] calldata orderBooks, uint8 state) external;
    /// Governance only.
    function whitelistSpotToken(address token, bool status) external;
    function owner() external view returns (address);
    function authority() external view returns (address);
}

/// Kuru v2 balances, accounts and book registry.
interface IKuruAccountCore {
    /// `user`'s root account id; 0 until the account exists. An account is created by the first deposit
    /// to it by owner (`deposit(address,...)`); only books may call AccountCore's ensureRootAccount.
    function rootAccountIdOf(address user) external view returns (uint40);
    /// Pulls `amount` of `token` from the caller (approve AccountCore first) into `rootOwner`'s root
    /// account, creating the account on first use.
    function deposit(address rootOwner, address token, uint256 amount) external payable;
    /// Pulls `amount` of `token` from the caller into an existing root account.
    function deposit(uint40 rootAccountId, address token, uint256 amount) external payable;
    /// Sends `amount` of `token` from the caller's account to `recipient`, through the WithdrawalLimiter.
    function withdraw(uint40 rootAccountId, address token, uint256 amount, address recipient) external;
    function getBalance(uint40 accountId, address token) external view returns (uint256);
    function getSpotReservedBalance(uint40 accountId, address token) external view returns (uint256);
    /// True for every book registered with AccountCore (Kuru's SpotRouter registers each one it deploys).
    function verifiedSpotOrderBook(address book) external view returns (bool);
    function spotOrderBookToBaseToken(address book) external view returns (address);
    function spotOrderBookToQuoteToken(address book) external view returns (address);
    function spotTokenConfigs(address token) external view returns (uint8 decimals, bool enabled);
    function withdrawalLimiter() external view returns (address);
    function withdrawalsFrozen() external view returns (bool);
    function tokenWithdrawalsFrozen(address token) external view returns (bool);
    function protocolPaused() external view returns (bool);
    /// The taker fee `accountId` pays on a book whose own taker fee is `marketTakerFeePps`.
    function effectiveSpotTakerFeePps(uint40 accountId, uint256 marketTakerFeePps) external view returns (uint32);
    /// Governance only.
    function configureSpotToken(address token, bool enabled) external;
    function owner() external view returns (address);
}

/// One Kuru v2 spot book (YES/USDC for Hunch Book).
interface IKuruSpotOrderBook {
    /// Exact-in market order from `userId`'s AccountCore balance. Buy: `amountIn` is quote, out is base.
    /// Sell: `amountIn` is base, out is quote. Reverts if out < `minAmountOut` or after `deadline`
    /// (unix seconds). `amountInUsed` can be below `amountIn` when liquidity runs out or the rest is dust.
    function swap(uint40 userId, bool isBuy, uint128 amountIn, uint128 minAmountOut, uint64 deadline)
        external
        returns (KuruSwapResult memory result);

    /// What `swap` would do now for `userId` (their fee tier applies).
    function estimateSwap(uint40 userId, bool isBuy, uint128 amountIn)
        external
        view
        returns (KuruSwapResult memory result);

    /// What `swap` would do now at the book's own fees (for a caller with no account yet).
    function estimateSwap(bool isBuy, uint128 amountIn) external view returns (KuruSwapResult memory result);

    /// Best bid and ask in pricePrecision units.
    function bestBidAsk() external view returns (uint32 bid, uint32 ask);
    function getL2Book(uint256 levels)
        external
        view
        returns (
            uint32[] memory bidPrices,
            uint96[] memory bidSizes,
            uint32[] memory askPrices,
            uint96[] memory askSizes
        );
    /// Latest trade price scaled by 1e8 and its timestamp.
    function lastTradeObservation() external view returns (uint64 priceX8, uint32 timestamp);

    function accountCore() external view returns (address);
    function baseToken() external view returns (address);
    function quoteToken() external view returns (address);
    function pricePrecision() external view returns (uint32);
    function sizePrecision() external view returns (uint96);
    function tickSize() external view returns (uint32);
    function passiveSpreadTicks() external view returns (uint32);
    function minQuoteNotional() external view returns (uint96);
    function maxQuoteNotional() external view returns (uint96);
    function takerFeePps() external view returns (uint256);
    function makerFeePps() external view returns (uint256);
    /// 0 active, 1 soft pause, 2 hard pause.
    function marketState() external view returns (uint8);
}

/// Kuru's protocol-wide withdrawal budget (USD valued through one price source per token).
interface IKuruWithdrawalLimiter {
    struct CapacityState {
        uint256 depositCreditUsd36;
        uint256 dripCreditUsd36;
        uint256 availableUsd36;
    }

    function priceSource(address token) external view returns (address);
    function previewWithdrawal(address token, uint256 amount)
        external
        view
        returns (uint256 requiredUsd36, uint256 availableUsd36, bool withinLimit);
    function getCapacityState() external view returns (CapacityState memory state);
    /// Owner only.
    function setPriceSource(address token, address source) external;
    function owner() external view returns (address);
}
