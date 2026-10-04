// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ICollateralVault} from "../interfaces/ICollateralVault.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {Outcome, Side, Window} from "../interfaces/IHunchBookTypes.sol";
import {IImpliedProbabilityOracle} from "./interfaces/IImpliedProbabilityOracle.sol";
import {IOutcomeTokenPriceAdapter} from "./interfaces/IOutcomeTokenPriceAdapter.sol";
import {IOutcomeTokenPriceAdapterFactory} from "./interfaces/IOutcomeTokenPriceAdapterFactory.sol";

/// The market's fee rate, a public constant on Market (2% of winnings, in basis points).
interface IMarketFeeBps {
    function FEE_BPS() external view returns (uint256);
}

interface IERC20Symbol {
    function symbol() external view returns (string memory);
}

/// @title OutcomeTokenPriceAdapter
/// @notice Chainlink-compatible conservative price of one Hunch Book outcome token (roadmap V-7).
/// See IOutcomeTokenPriceAdapter and docs/PERIPHERY.md. Deployed only by
/// OutcomeTokenPriceAdapterFactory, which supplies the parameters. No owner, nothing to update.
///
/// Bounds, for every input: 0 <= value <= 1 - fee(side), where fee(side) is the redemption fee per
/// token this side pays if it wins (rounded up, as the vault charges it). Rounding always goes down
/// for the value and up for the haircut.
contract OutcomeTokenPriceAdapter is IOutcomeTokenPriceAdapter {
    uint256 internal constant ONE = 1e6;
    uint256 internal constant BPS = 10_000;
    /// E6 to the 8-decimal answer.
    uint256 internal constant TO_ANSWER = 100;

    /// @inheritdoc IOutcomeTokenPriceAdapter
    address public immutable market;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    Side public immutable side;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    address public immutable token;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    address public immutable oracle;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    address public immutable vault;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    uint256 public immutable twapWindow;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    uint256 public immutable baseHaircutBps;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    uint256 public immutable closeHaircutBps;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    uint256 public immutable rampSeconds;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    uint256 public immutable spreadMultiplierBps;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    uint256 public immutable maxSpreadHaircutBps;
    /// @inheritdoc IOutcomeTokenPriceAdapter
    uint256 public immutable blockTimeMs;

    /// Called by the factory, which has checked the market and the parameters.
    constructor(address market_, Side side_) {
        IOutcomeTokenPriceAdapterFactory f = IOutcomeTokenPriceAdapterFactory(msg.sender);
        IOutcomeTokenPriceAdapterFactory.AdapterParams memory p = f.params();
        market = market_;
        side = side_;
        (address yes, address no) = IMarket(market_).tokens();
        token = side_ == Side.Yes ? yes : no;
        oracle = f.oracle();
        vault = f.vault();
        twapWindow = p.twapWindow;
        baseHaircutBps = p.baseHaircutBps;
        closeHaircutBps = p.closeHaircutBps;
        rampSeconds = p.rampSeconds;
        spreadMultiplierBps = p.spreadMultiplierBps;
        maxSpreadHaircutBps = p.maxSpreadHaircutBps;
        blockTimeMs = p.blockTimeMs;
    }

    // ------------------------------------------------------------------------------------------
    // AggregatorV3Interface
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function decimals() external pure returns (uint8) {
        return 8;
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function description() external view returns (string memory) {
        return string.concat(IERC20Symbol(token).symbol(), " / USD");
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function latestRoundData()
        public
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 value;
        (value, updatedAt) = valueE6();
        // A unix timestamp fits in uint80, and value * 100 <= 1e8 fits in int256.
        // forge-lint: disable-next-line(unsafe-typecast)
        roundId = uint80(updatedAt);
        // forge-lint: disable-next-line(unsafe-typecast)
        answer = int256(value * TO_ANSWER);
        startedAt = updatedAt;
        answeredInRound = roundId;
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (roundId_, answer, startedAt, updatedAt, answeredInRound) = latestRoundData();
        if (roundId != roundId_) revert RoundNotAvailable(roundId);
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function latestAnswer() external view returns (int256 answer) {
        (, answer,,,) = latestRoundData();
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function latestTimestamp() external view returns (uint256 updatedAt) {
        (,,, updatedAt,) = latestRoundData();
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function latestRound() external view returns (uint256 roundId) {
        (roundId,,,,) = latestRoundData();
    }

    // ------------------------------------------------------------------------------------------
    // Adapter
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function valueE6() public view returns (uint256 value, uint256 updatedAt) {
        ICollateralVault.Ledger memory l = ICollateralVault(vault).ledger(market);
        if (l.status == ICollateralVault.Status.Settled) {
            Side winning = l.outcome == Outcome.Yes ? Side.Yes : Side.No;
            if (side == winning) value = ONE - FixedPointMathLib.mulDivUp(ONE, l.feeNumerator, l.feeDenominator);
            return (value, block.timestamp);
        }
        if (l.status == ICollateralVault.Status.Voided) return (ONE / 2, block.timestamp);

        (uint256 chanceTwap, uint256 spreadTwap, uint256 updated) =
            IImpliedProbabilityOracle(oracle).consultFull(market, twapWindow);
        uint256 sideTwap = side == Side.Yes ? chanceTwap : ONE - chanceTwap;
        value = sideTwap * (BPS - _haircut(spreadTwap)) / BPS;
        uint256 cap = ONE - _winFee();
        if (value > cap) value = cap;
        updatedAt = updated;
    }

    /// @inheritdoc IOutcomeTokenPriceAdapter
    function haircutBps() external view returns (uint256) {
        ICollateralVault.Status s = ICollateralVault(vault).ledger(market).status;
        if (s == ICollateralVault.Status.Settled || s == ICollateralVault.Status.Voided) return 0;
        (, uint256 spreadTwap,) = IImpliedProbabilityOracle(oracle).consultFull(market, twapWindow);
        return _haircut(spreadTwap);
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    /// time part + spread part, at most 100%.
    function _haircut(uint256 spreadTwapE6) internal view returns (uint256) {
        uint256 left = _secondsToClose();
        uint256 timePart = left >= rampSeconds
            ? baseHaircutBps
            : closeHaircutBps - (closeHaircutBps - baseHaircutBps) * left / rampSeconds;
        uint256 spreadPart = FixedPointMathLib.mulDivUp(spreadTwapE6, spreadMultiplierBps, ONE);
        if (spreadPart > maxSpreadHaircutBps) spreadPart = maxSpreadHaircutBps;
        uint256 total = timePart + spreadPart;
        return total > BPS ? BPS : total;
    }

    /// Seconds until the market's close: exact for time-clock markets, estimated from `blockTimeMs`
    /// for block-clock markets. Zero at and after close.
    function _secondsToClose() internal view returns (uint256) {
        Window memory w = IMarket(market).window();
        if (w.blockClock) {
            return block.number >= w.close ? 0 : (w.close - block.number) * blockTimeMs / 1000;
        }
        return block.timestamp >= w.close ? 0 : w.close - block.timestamp;
    }

    /// The fee per token (E6, rounded up as the vault charges it) this side pays if it wins. Fixed at
    /// graduation; before graduation the totals can still move, so the full rate is assumed.
    function _winFee() internal view returns (uint256) {
        uint256 feeBps = IMarketFeeBps(market).FEE_BPS();
        if (!IMarket(market).graduated()) return FixedPointMathLib.mulDivUp(ONE, feeBps, BPS);
        (uint256 y, uint256 n,) = IMarket(market).poolTotals();
        uint256 losing = side == Side.Yes ? n : y;
        return FixedPointMathLib.mulDivUp(ONE, feeBps * losing, BPS * (y + n));
    }
}
