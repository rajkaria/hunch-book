// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Kuru's MarginAccount as the Graduator sees it: a registry of verified books that only the Router
/// can add to.
contract MockKuruMarginAccount {
    error OnlyRouterAllowed();

    address public router;
    mapping(address => bool) public verifiedMarket;

    function setRouter(address router_) external {
        router = router_;
    }

    function updateMarkets(address market) external {
        if (msg.sender != router) revert OnlyRouterAllowed();
        verifiedMarket[market] = true;
    }
}
