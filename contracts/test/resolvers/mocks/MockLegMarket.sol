// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Outcome, Phase, Window} from "../../../src/interfaces/IHunchBookTypes.sol";

/// The few IMarket views the parlay resolver reads, with every value settable. Real markets are used
/// in the integration tests; this one lets fuzz tests reach any combination quickly.
contract MockLegMarket {
    Phase public phase;
    Outcome public outcome;
    bytes32 public evidenceHash;
    uint256 public marketId;
    Window internal _window;

    constructor(uint256 id, Window memory w) {
        marketId = id;
        _window = w;
    }

    function set(Phase p, Outcome o, bytes32 h) external {
        (phase, outcome, evidenceHash) = (p, o, h);
    }

    function setWindow(Window memory w) external {
        _window = w;
    }

    function window() external view returns (Window memory) {
        return _window;
    }
}

/// A factory stand-in that knows which addresses are its markets.
contract MockLegFactory {
    mapping(address => bool) public isMarket;

    function add(address market) external {
        isMarket[market] = true;
    }
}
