// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MarketCaps, Phase} from "../../src/interfaces/IHunchBookTypes.sol";

/// The `IMarket` views HunchRouter and Graduator read: phase, book, tokens, caps. Settable by tests.
contract MockMarketForRouter {
    Phase public phase;
    address public book;
    address public yes;
    address public no;
    MarketCaps internal _caps;

    constructor(address yes_, address no_, uint128 poolCap) {
        yes = yes_;
        no = no_;
        _caps.poolCap = poolCap;
        phase = Phase.Pool;
    }

    function tokens() external view returns (address, address) {
        return (yes, no);
    }

    function caps() external view returns (MarketCaps memory) {
        return _caps;
    }

    function setPhase(Phase p) external {
        phase = p;
    }

    function setBook(address b) external {
        book = b;
    }

    function setPoolCap(uint128 poolCap) external {
        _caps.poolCap = poolCap;
    }
}

/// The `IHunchBookFactory` views HunchRouter and Graduator read: isMarket, vault, usdc.
contract MockFactoryForRouter {
    address public vault;
    address public usdc;
    mapping(address => bool) public isMarket;

    constructor(address vault_, address usdc_) {
        vault = vault_;
        usdc = usdc_;
    }

    function setMarket(address market, bool known) external {
        isMarket[market] = known;
    }
}
