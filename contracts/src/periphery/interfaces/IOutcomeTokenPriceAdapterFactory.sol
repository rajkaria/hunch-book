// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Side} from "../../interfaces/IHunchBookTypes.sol";

/// Deploys one OutcomeTokenPriceAdapter per (market, side) at a deterministic address, all with the
/// same haircut parameters, fixed when this factory is deployed (docs/PERIPHERY.md).
interface IOutcomeTokenPriceAdapterFactory {
    /// Haircut and averaging parameters shared by every adapter from one factory. See
    /// IOutcomeTokenPriceAdapter for how they combine.
    struct AdapterParams {
        uint32 twapWindow; // seconds; at most the oracle's maxWindow()
        uint16 baseHaircutBps; // haircut far from close
        uint16 closeHaircutBps; // haircut at and after close; >= baseHaircutBps
        uint32 rampSeconds; // the time haircut ramps over this many seconds before close; > 0
        uint32 spreadMultiplierBps; // 10000: a 0.03 USDC spread adds 300 bps
        uint16 maxSpreadHaircutBps; // cap on the spread part, also used for an empty or one-sided book
        uint32 blockTimeMs; // estimate for block-clock markets; lower is more conservative
    }

    event AdapterCreated(address indexed market, Side indexed side, address adapter);

    error UnknownMarket();
    error AdapterExists(address adapter);
    error BadParams();
    error ZeroAddress();

    /// Deploys the adapter for (`market`, `side`). Anyone can call it, once per pair.
    function createAdapter(address market, Side side) external returns (address adapter);

    /// The deployed adapter for (`market`, `side`), or zero.
    function adapterOf(address market, Side side) external view returns (address);

    /// Where the adapter for (`market`, `side`) is (or will be) deployed.
    function predictAdapter(address market, Side side) external view returns (address);

    function params() external view returns (AdapterParams memory);
    function oracle() external view returns (address);
    function vault() external view returns (address);
}
