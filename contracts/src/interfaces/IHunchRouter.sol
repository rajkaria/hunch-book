// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Atomic trades on a graduated market's Kuru YES/USDC book. Holds no balance between transactions;
/// approvals to the book are set to the exact amount per call and reset to zero.
/// Every call checks the deadline and the minimum out (or maximum in), and reverts once the
/// market is past close.
interface IHunchRouter {
    enum Kind {
        BuyYes,
        SellYes,
        BuyNo,
        SellNo
    }

    event Trade(
        address indexed market, address indexed user, Kind kind, uint256 amountIn, uint256 amountOut, address book
    );

    error Expired();
    error NotTradable();
    error UnknownMarket();
    error Slippage();
    error ZeroAmount();

    /// Spend `usdcIn` on YES. Returns YES received.
    function buyYes(address market, uint256 usdcIn, uint256 minYesOut, uint256 deadline) external returns (uint256);
    /// Sell `yesIn` YES. Returns USDC received.
    function sellYes(address market, uint256 yesIn, uint256 minUsdcOut, uint256 deadline) external returns (uint256);
    /// Receive exactly `noOut` NO: mint sets with a flash loan, sell the YES. Returns USDC paid.
    function buyNo(address market, uint256 noOut, uint256 maxUsdcIn, uint256 deadline) external returns (uint256);
    /// Sell `noIn` NO: flash-borrow, buy YES, merge, repay. Returns USDC received.
    function sellNo(address market, uint256 noIn, uint256 minUsdcOut, uint256 deadline) external returns (uint256);
}
