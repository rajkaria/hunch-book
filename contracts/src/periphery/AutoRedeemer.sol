// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ICollateralVault} from "../interfaces/ICollateralVault.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IOutcomeToken} from "../interfaces/IOutcomeToken.sol";
import {Outcome, Side} from "../interfaces/IHunchBookTypes.sol";
import {IAutoRedeemer} from "./interfaces/IAutoRedeemer.sol";

interface IERC20PermitAllowance {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title AutoRedeemer
/// @notice Opt-in auto-redeem (roadmap K-3). See IAutoRedeemer and docs/PERIPHERY.md.
///
/// Flow per holder and side: pull min(balance, allowance) tokens from the holder, then call
/// `vault.redeem(market, side, amount, holder)`, which burns them from this contract and pays the
/// holder directly. This contract never receives USDC and ends every call with the token balances
/// it started with (zero in normal use).
///
/// Consent is two-layered: the holder's opt-in flag (global, with per-market opt-outs) and the
/// holder's token allowance to this contract. Both must be in place. Settled markets redeem only the
/// winning side; voided markets redeem both sides at 0.50.
contract AutoRedeemer is IAutoRedeemer {
    using SafeTransferLib for address;

    /// @inheritdoc IAutoRedeemer
    address public immutable factory;
    /// @inheritdoc IAutoRedeemer
    address public immutable vault;

    /// @inheritdoc IAutoRedeemer
    mapping(address holder => bool) public optedIn;
    /// @inheritdoc IAutoRedeemer
    mapping(address holder => mapping(address market => bool)) public optedOut;

    bool private transient _locked;

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(IHunchBookFactory factory_) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        address vault_ = factory_.vault();
        if (vault_ == address(0)) revert ZeroAddress();
        factory = address(factory_);
        vault = vault_;
    }

    // ------------------------------------------------------------------------------------------
    // Holder settings
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IAutoRedeemer
    function setOptIn(bool on) external {
        optedIn[msg.sender] = on;
        emit OptInSet(msg.sender, on);
    }

    /// @inheritdoc IAutoRedeemer
    function setMarketOptOut(address market, bool out) external {
        if (!IHunchBookFactory(factory).isMarket(market)) revert UnknownMarket();
        optedOut[msg.sender][market] = out;
        emit MarketOptOutSet(msg.sender, market, out);
    }

    /// @inheritdoc IAutoRedeemer
    /// @dev The token must be the YES or NO token of a market this factory created. A permit that
    /// reverts (already submitted by someone else, who cannot redirect it) is accepted only if the
    /// allowance it set is in place.
    function optInWithPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        _requireOutcomeToken(token);
        try IERC20PermitAllowance(token).permit(msg.sender, address(this), value, deadline, v, r, s) {}
        catch {
            if (IERC20PermitAllowance(token).allowance(msg.sender, address(this)) < value) revert PermitFailed();
        }
        optedIn[msg.sender] = true;
        emit OptInSet(msg.sender, true);
    }

    // ------------------------------------------------------------------------------------------
    // Redemption (anyone)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IAutoRedeemer
    function redeemFor(address market, address holder) external nonReentrant returns (uint256 paid) {
        ICollateralVault.Ledger memory l = _redeemableLedger(market);
        if (!isActive(holder, market)) revert NotOptedIn();
        bool any;
        (paid, any) = _redeem(market, l, holder, msg.sender);
        if (!any) revert NothingToRedeem();
    }

    /// @inheritdoc IAutoRedeemer
    /// @dev Each holder runs through an external self-call inside try/catch, so a revert for one holder
    /// (the only realistic one is USDC refusing a transfer to that holder) rolls back that holder only.
    function redeemManyFor(address market, address[] calldata holders)
        external
        nonReentrant
        returns (uint256 paid, uint256 redeemed)
    {
        _redeemableLedger(market);
        for (uint256 i; i < holders.length; ++i) {
            address holder = holders[i];
            if (!isActive(holder, market)) continue;
            // forge-lint: disable-next-line(calls-loop)
            try this.selfRedeem(market, holder, msg.sender) returns (uint256 p, bool any) {
                if (any) {
                    paid += p;
                    ++redeemed;
                }
            } catch (bytes memory reason) {
                emit RedeemFailed(market, holder, reason);
            }
        }
    }

    /// One holder's redemption for `redeemManyFor`, which passes its own caller as `caller`. Only this
    /// contract can call it, and only from inside `redeemManyFor`, which holds the reentrancy lock and
    /// has checked the market.
    function selfRedeem(address market, address holder, address caller) external returns (uint256 paid, bool any) {
        if (msg.sender != address(this)) revert OnlySelf();
        return _redeem(market, ICollateralVault(vault).ledger(market), holder, caller);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IAutoRedeemer
    function isActive(address holder, address market) public view returns (bool) {
        return optedIn[holder] && !optedOut[holder][market];
    }

    /// @inheritdoc IAutoRedeemer
    function redeemable(address market, address holder)
        external
        view
        returns (uint256 yesAmount, uint256 noAmount, uint256 paid)
    {
        if (!IHunchBookFactory(factory).isMarket(market) || !isActive(holder, market)) return (0, 0, 0);
        ICollateralVault.Ledger memory l = ICollateralVault(vault).ledger(market);
        if (l.status == ICollateralVault.Status.Settled) {
            bool yesWon = l.outcome == Outcome.Yes;
            uint256 amount = _amount(yesWon ? l.yes : l.no, holder);
            if (yesWon) yesAmount = amount;
            else noAmount = amount;
            paid = amount - FixedPointMathLib.mulDivUp(amount, l.feeNumerator, l.feeDenominator);
        } else if (l.status == ICollateralVault.Status.Voided) {
            yesAmount = _even(_amount(l.yes, holder));
            noAmount = _even(_amount(l.no, holder));
            paid = (yesAmount + noAmount) / 2;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    function _redeemableLedger(address market) internal view returns (ICollateralVault.Ledger memory l) {
        if (!IHunchBookFactory(factory).isMarket(market)) revert UnknownMarket();
        l = ICollateralVault(vault).ledger(market);
        if (l.status != ICollateralVault.Status.Settled && l.status != ICollateralVault.Status.Voided) {
            revert NotRedeemable();
        }
    }

    function _redeem(address market, ICollateralVault.Ledger memory l, address holder, address caller)
        internal
        returns (uint256 paid, bool any)
    {
        if (l.status == ICollateralVault.Status.Settled) {
            (Side side, address token) = l.outcome == Outcome.Yes ? (Side.Yes, l.yes) : (Side.No, l.no);
            uint256 amount = _amount(token, holder);
            if (amount != 0) {
                paid = _redeemSide(market, side, token, holder, amount, caller);
                any = true;
            }
        } else {
            // Voided: 0.50 per token, rounded down by the vault, so redeem even amounts only.
            uint256 yesAmount = _even(_amount(l.yes, holder));
            uint256 noAmount = _even(_amount(l.no, holder));
            if (yesAmount != 0) paid += _redeemSide(market, Side.Yes, l.yes, holder, yesAmount, caller);
            if (noAmount != 0) paid += _redeemSide(market, Side.No, l.no, holder, noAmount, caller);
            any = yesAmount != 0 || noAmount != 0;
        }
    }

    function _redeemSide(address market, Side side, address token, address holder, uint256 amount, address caller)
        internal
        returns (uint256 paid)
    {
        // The holder approved this contract for exactly this use: `holder` is the only possible payee.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        token.safeTransferFrom(holder, address(this), amount);
        paid = ICollateralVault(vault).redeem(market, side, amount, holder);
        emit AutoRedeemed(market, holder, side, amount, paid, caller);
    }

    /// min(balance, allowance) of `holder` for `token` towards this contract.
    function _amount(address token, address holder) internal view returns (uint256) {
        uint256 bal = token.balanceOf(holder);
        uint256 allowed = IERC20PermitAllowance(token).allowance(holder, address(this));
        return bal < allowed ? bal : allowed;
    }

    function _even(uint256 x) internal pure returns (uint256) {
        return x & ~uint256(1);
    }

    function _requireOutcomeToken(address token) internal view {
        if (token.code.length == 0) revert UnknownToken();
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IOutcomeToken.market, ()));
        if (!ok || ret.length < 32) revert UnknownToken();
        address market = abi.decode(ret, (address));
        if (!IHunchBookFactory(factory).isMarket(market)) revert UnknownToken();
        (address yes, address no) = ICollateralVault(vault).tokensOf(market);
        if (token != yes && token != no) revert UnknownToken();
    }
}
