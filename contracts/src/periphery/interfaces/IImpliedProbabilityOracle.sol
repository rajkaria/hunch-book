// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Phase} from "../../interfaces/IHunchBookTypes.sol";

/// The market's implied chance of YES, onchain (roadmap V-6, docs/PERIPHERY.md). All values are E6:
/// 1_000_000 = 100% = 1 USDC per YES token.
///
/// Spot chance by phase:
///   Pool, PoolLocked:  Y / T from the pool totals (50% while the pool is empty).
///   Graduated, Closed: the mid of the Kuru YES book; a one-sided book reads that side; an empty book
///                      reads the last recorded observation (or the opening price Y / T if there is
///                      none) and is flagged stale.
///   Settled:           100% if YES won, 0 if NO won.
///   Voided:            50%.
/// Each read also has a spread: ask - bid for a two-sided book, 100% (1e6) when the book is one-sided
/// or empty and during the pool phase, 0 once settled or voided.
///
/// Time-weighted averages work like Uniswap's oracles. `poke(market)` (anyone, at most once per block
/// per market) records the spot chance and spread; each recorded value holds from that poke until the
/// next. The accumulators sum value x seconds. A poke stores a checkpoint at most every `MIN_SPACING`
/// seconds in a ring of `CAPACITY` checkpoints per market, so frequent pokes cannot shorten the history
/// below `maxWindow()` seconds. `consult` reads the accumulator now and `secondsAgo` seconds back
/// (interpolating between checkpoints) and returns the average.
interface IImpliedProbabilityOracle {
    /// One recorded point. `chanceE6` and `spreadE6` are the values recorded at `timestamp`; the
    /// cumulatives are the sums of value x seconds up to `timestamp`.
    struct Observation {
        uint40 timestamp;
        uint24 chanceE6;
        uint24 spreadE6;
        uint88 chanceCumulative;
        uint80 spreadCumulative;
    }

    /// Everything the spot read saw.
    struct Quote {
        Phase phase;
        uint256 chanceE6;
        uint256 spreadE6;
        bool stale;
        bool hasBid;
        bool hasAsk;
        uint256 bidE6; // YES bid, not capped
        uint256 askE6; // YES ask, not capped
    }

    event Poked(address indexed market, uint256 chanceE6, uint256 spreadE6, bool stale, bool checkpoint);

    error UnknownMarket();
    error ZeroAddress();
    error BadKuruVersion();
    error ZeroPeriod();
    error NoObservations();
    error InsufficientHistory(uint256 oldestTimestamp);

    /// Spot chance of YES now, and whether it is stale (an empty book read the last observation).
    function chanceE6(address market) external view returns (uint256 chance, bool stale);

    /// The full spot read: phase, chance, spread, staleness and the YES best bid and ask.
    function quote(address market) external view returns (Quote memory);

    /// Records the spot chance and spread for `market`. Anyone can call it. Returns false, without
    /// reverting, if the market was already poked in this block. Reverts for unknown markets.
    function poke(address market) external returns (bool written);

    /// `poke` for each market, skipping any already poked in this block. Returns how many were written.
    function pokeMany(address[] calldata markets) external returns (uint256 written);

    /// Time-weighted average chance over the last `secondsAgo` seconds. Reverts `NoObservations`
    /// before the first poke and `InsufficientHistory` if the oldest checkpoint is younger than that.
    function consult(address market, uint256 secondsAgo) external view returns (uint256 chanceTwapE6);

    /// `consult` plus the time-weighted average spread over the same period, and the time of the
    /// latest poke (how fresh the data is).
    function consultFull(address market, uint256 secondsAgo)
        external
        view
        returns (uint256 chanceTwapE6, uint256 spreadTwapE6, uint256 updatedAt);

    /// The latest recorded observation (zero before the first poke).
    function latest(address market) external view returns (Observation memory);

    /// Number of checkpoints stored for `market` (at most CAPACITY).
    function checkpointCount(address market) external view returns (uint256);

    /// Checkpoint `index`, oldest first (index < checkpointCount).
    function checkpointAt(address market, uint256 index) external view returns (Observation memory);

    /// History every market keeps once its ring is full: (CAPACITY - 1) x MIN_SPACING seconds.
    function maxWindow() external view returns (uint256);

    function factory() external view returns (address);
    /// Kuru version of the stack's books (1 or 2): how graduated markets' books are read.
    function kuruVersion() external view returns (uint8);
    function CAPACITY() external view returns (uint256);
    function MIN_SPACING() external view returns (uint256);
}
