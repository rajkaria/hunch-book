// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Side} from "../../interfaces/IHunchBookTypes.sol";

/// A Chainlink AggregatorV3-compatible price for one outcome token (one market, one side), for lending
/// markets that accept YES or NO tokens as collateral (roadmap V-7, docs/PERIPHERY.md).
///
/// The answer is a conservative value of 1 token in USDC (reported as USD, assuming 1 USDC = 1 USD)
/// with 8 decimals:
///   Settled: the exact redemption value, 1 - fee for the winning side and 0 for the losing side.
///   Voided:  0.50.
///   Otherwise: the oracle's time-weighted chance for this side over `twapWindow` seconds (NO = 1 - YES),
///   times (1 - haircut), capped at 1 - the redemption fee this side would pay if it won. The haircut is
///   a time part, which ramps from `baseHaircutBps` to `closeHaircutBps` over the last `rampSeconds`
///   before close, plus a spread part, the time-weighted book spread times `spreadMultiplierBps`, capped
///   at `maxSpreadHaircutBps`. The total haircut is capped at 100%, so the answer is never negative.
///
/// `updatedAt` is the oracle's latest poke for a live market (consumers should check it is recent),
/// and the current time once the market is settled or voided (the value is final). Only the latest
/// round exists: `getRoundData` returns it for its own round id and reverts for any other.
interface IOutcomeTokenPriceAdapter {
    error RoundNotAvailable(uint80 roundId);

    // ---- AggregatorV3Interface ----

    /// Always 8.
    function decimals() external view returns (uint8);
    /// For example "HB1-YES / USD".
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    // ---- AggregatorV2 extras ----

    function latestAnswer() external view returns (int256);
    function latestTimestamp() external view returns (uint256);
    function latestRound() external view returns (uint256);

    // ---- adapter ----

    /// The value of 1 token in USDC E6 (before scaling to 8 decimals), and when it was last updated.
    function valueE6() external view returns (uint256 value, uint256 updatedAt);

    /// The haircut that applies right now, in basis points (0 once settled or voided).
    function haircutBps() external view returns (uint256);

    function market() external view returns (address);
    function side() external view returns (Side);
    function token() external view returns (address);
    function oracle() external view returns (address);
    function vault() external view returns (address);
    function twapWindow() external view returns (uint256);
    function baseHaircutBps() external view returns (uint256);
    function closeHaircutBps() external view returns (uint256);
    function rampSeconds() external view returns (uint256);
    function spreadMultiplierBps() external view returns (uint256);
    function maxSpreadHaircutBps() external view returns (uint256);
    function blockTimeMs() external view returns (uint256);
}
