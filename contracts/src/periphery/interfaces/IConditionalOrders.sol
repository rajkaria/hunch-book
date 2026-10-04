// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IHunchRouter} from "../../interfaces/IHunchRouter.sol";

/// Take-profit, stop-loss and limit orders on outcome tokens (roadmap A-11, docs/PERIPHERY.md).
///
/// An order waits for a price on the market's Kuru book, then anyone executes it through the
/// HunchRouter. Funds stay with the owner until execution (approval model): the owner approves this
/// contract for the input token, and `execute` pulls exactly what that one order needs.
///
/// Prices are E6 (USDC base units per 1 token) on the traded side's own book price:
///   BuyYes: YES ask. SellYes: YES bid. BuyNo: NO ask = 1 - YES bid. SellNo: NO bid = 1 - YES ask.
/// Take-profit = a sell AtOrAbove, stop-loss = a sell AtOrBelow, limit buy = a buy AtOrBelow.
///
/// `amountIn` and `limit` per kind:
///   BuyYes:  amountIn = USDC to spend.          limit = minimum YES the owner receives.
///   SellYes: amountIn = YES to sell.            limit = minimum USDC the owner receives.
///   BuyNo:   amountIn = NO to buy (exact).      limit = maximum USDC the owner pays.
///   SellNo:  amountIn = NO to sell.             limit = minimum USDC the owner receives.
/// "Receives" is after the executor tip, which comes out of the output (BuyNo: out of the NO).
interface IConditionalOrders {
    enum Condition {
        AtOrAbove,
        AtOrBelow
    }

    enum Status {
        None,
        Open,
        Executed,
        Cancelled
    }

    /// What `place` takes. The caller becomes the owner.
    struct OrderRequest {
        address market;
        IHunchRouter.Kind kind;
        Condition condition;
        uint32 triggerPriceE6;
        uint64 expiry; // unix seconds, inclusive
        uint16 executorTipBps; // 0 to MAX_TIP_BPS
        uint128 amountIn;
        uint128 limit;
    }

    struct Order {
        address owner;
        uint64 expiry;
        uint32 triggerPriceE6;
        address market;
        IHunchRouter.Kind kind;
        Condition condition;
        Status status;
        uint16 executorTipBps;
        uint128 amountIn;
        uint128 limit;
    }

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed owner,
        address indexed market,
        IHunchRouter.Kind kind,
        Condition condition,
        uint32 triggerPriceE6,
        uint64 expiry,
        uint16 executorTipBps,
        uint128 amountIn,
        uint128 limit
    );
    event OrderCancelled(uint256 indexed orderId, address indexed owner);
    /// `priceE6` is the trigger-side price the order executed at; `spent` is the input used, `received`
    /// the output the owner got after the tip, `tip` the output paid to `executor`.
    event OrderExecuted(
        uint256 indexed orderId,
        address indexed owner,
        address indexed executor,
        uint256 priceE6,
        uint256 spent,
        uint256 received,
        uint256 tip
    );

    error UnknownMarket();
    error ZeroAmount();
    error TipTooHigh();
    error BadTrigger();
    error BadExpiry();
    error UnknownOrder(uint256 orderId);
    error OrderNotOpen(uint256 orderId);
    error OrderExpired(uint256 orderId);
    error NotTriggered(uint256 orderId, bool priceAvailable, uint256 priceE6);
    error NotOwner();
    error Slippage();
    error Reentrancy();
    error ZeroAddress();

    /// Places an order owned by the caller. Moves no funds. Returns the order id (ids start at 1).
    function place(OrderRequest calldata request) external returns (uint256 orderId);

    /// Cancels an open order. Only its owner, at any time.
    function cancel(uint256 orderId) external;

    /// Executes an open, unexpired order whose trigger holds against the book right now. Anyone can
    /// call it and receives the order's tip. Pulls the order's input from the owner, trades through
    /// the router with deadline = now, sends the output minus the tip to the owner and refunds any
    /// unspent input. Returns what the owner received.
    function execute(uint256 orderId) external returns (uint256 received);

    /// The trigger-side price for `kind` on `market`'s book now, and whether that side has a price.
    function currentPrice(address market, IHunchRouter.Kind kind)
        external
        view
        returns (bool available, uint256 priceE6);

    /// True if `execute(orderId)` would pass its status, expiry and trigger checks right now (the
    /// trade itself can still revert, for example on the order's limit).
    function isTriggered(uint256 orderId) external view returns (bool);

    function getOrder(uint256 orderId) external view returns (Order memory);
    function orderCount() external view returns (uint256);
    function factory() external view returns (address);
    function router() external view returns (address);
    function usdc() external view returns (address);
    function MAX_TIP_BPS() external view returns (uint256);
}
