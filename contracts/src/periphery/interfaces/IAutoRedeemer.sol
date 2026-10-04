// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Side} from "../../interfaces/IHunchBookTypes.sol";

/// Opt-in auto-redeem (roadmap K-3, docs/PERIPHERY.md). A holder opts in once and approves this
/// contract for the YES and NO tokens it may redeem. After a market settles or voids, anyone (in
/// practice the keeper) redeems those tokens through the vault, and the USDC goes straight from the
/// vault to the holder. The contract holds nothing between transactions, has no owner, and can only
/// ever send a holder's redemption to that same holder.
interface IAutoRedeemer {
    /// A holder turned auto-redeem on or off for every market.
    event OptInSet(address indexed holder, bool optedIn);
    /// A holder excluded one market from auto-redeem, or included it again.
    event MarketOptOutSet(address indexed holder, address indexed market, bool optedOut);
    /// `amount` of the holder's `side` tokens were redeemed and `paid` USDC sent to the holder.
    event AutoRedeemed(
        address indexed market, address indexed holder, Side side, uint256 amount, uint256 paid, address indexed caller
    );
    /// `redeemManyFor` skipped a holder whose redemption reverted (for example, USDC refused the
    /// transfer to that address). Nothing moved for that holder.
    event RedeemFailed(address indexed market, address indexed holder, bytes reason);

    error UnknownMarket();
    error NotRedeemable();
    error NotOptedIn();
    error NothingToRedeem();
    error UnknownToken();
    error PermitFailed();
    error OnlySelf();
    error Reentrancy();
    error ZeroAddress();

    /// Turns auto-redeem on or off for the caller, across every market.
    function setOptIn(bool optedIn) external;

    /// Excludes (`optedOut` = true) or re-includes one market for the caller.
    function setMarketOptOut(address market, bool optedOut) external;

    /// Approves this contract for `value` of an outcome `token` with the caller's EIP-2612 permit
    /// signature and opts the caller in, in one transaction. If the permit was already used (someone
    /// submitted it first), succeeds as long as the allowance is at least `value`.
    function optInWithPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;

    /// Redeems what `holder` has approved on a settled or voided `market`, paying the holder.
    /// Settled: the winning side, at 1 - fee per token. Voided: both sides, at 0.50 per token (an even
    /// amount per side, so no half unit is lost to rounding). Amount per side = min(balance, allowance).
    /// Reverts `NotOptedIn` or `NothingToRedeem` when there is nothing to do. Returns the USDC paid.
    function redeemFor(address market, address holder) external returns (uint256 paid);

    /// `redeemFor` for each holder. Skips holders that are not opted in or have nothing to redeem,
    /// and isolates each holder, so one failing holder never reverts the batch.
    /// Returns the USDC paid in total and the number of holders paid.
    function redeemManyFor(address market, address[] calldata holders) external returns (uint256 paid, uint256 redeemed);

    /// What `redeemFor(market, holder)` would redeem and pay right now (zeros if it would revert).
    function redeemable(address market, address holder)
        external
        view
        returns (uint256 yesAmount, uint256 noAmount, uint256 paid);

    /// True if `holder` is opted in and has not opted out of `market`.
    function isActive(address holder, address market) external view returns (bool);

    function optedIn(address holder) external view returns (bool);
    function optedOut(address holder, address market) external view returns (bool);
    function factory() external view returns (address);
    function vault() external view returns (address);
}
