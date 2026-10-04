// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "../core/Base.t.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {KuruMarketParams} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {PeripheryBook} from "./mocks/PeripheryBook.sol";

/// Shared fixture for the periphery suites: the real core (factory, vault, markets, outcome tokens,
/// HunchRouter) from BaseTest, plus graduated markets whose Kuru book is a PeripheryBook (the core
/// suites' Kuru mock with `bestBidAsk`). A maker holds complete sets and rests asks and bids.
abstract contract PeripheryBase is BaseTest {
    HunchRouter internal router;
    address internal maker = makeAddr("maker");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual override {
        super.setUp();
        router = new HunchRouter(IHunchBookFactory(address(factory)));
        _fund(maker, 20_000e6);
    }

    // ---- markets ----

    /// A market graduated onto a fresh PeripheryBook, with every staker's tokens claimed.
    /// Pool: creator 5 YES, users[0..5] 50 YES each, users[6..9] 60 NO each (T = 545, Y = 305, N = 240).
    function _graduatedWithBook(Window memory w) internal returns (Market m, PeripheryBook b) {
        m = _create(w, Side.Yes, CREATOR_MIN);
        b = _newBook(m);
        graduator.registerBook(address(m), address(b));
        _fillToRule(m);
        m.graduate();
        address[] memory stakers = new address[](11);
        for (uint256 i; i < 10; ++i) {
            stakers[i] = users[i];
        }
        stakers[10] = creator;
        m.claimTokensFor(stakers);
    }

    function _graduatedWithBook() internal returns (Market m, PeripheryBook b) {
        return _graduatedWithBook(_timeWindow());
    }

    function _newBook(Market m) internal returns (PeripheryBook) {
        (address y,) = m.tokens();
        return new PeripheryBook(
            KuruMarketParams({
                pricePrecision: 1e6,
                sizePrecision: 1e6,
                baseAsset: y,
                baseAssetDecimals: 6,
                quoteAsset: address(usdc),
                quoteAssetDecimals: 6,
                tickSize: 1000,
                minSize: 1e6,
                maxSize: uint96(POOL_CAP),
                takerFeeBps: 0,
                makerFeeBps: 0
            }),
            30
        );
    }

    // ---- liquidity ----

    /// The maker mints `size` complete sets and rests the YES as an ask at `price` (E6).
    function _ask(Market m, PeripheryBook b, uint32 price, uint96 size) internal {
        vm.startPrank(maker);
        vault.mintSets(address(m), size, maker);
        _yes(m).approve(address(b), size);
        b.addAskFrom(maker, price, size);
        vm.stopPrank();
    }

    /// Rests a bid at `price` (E6) for `size` YES (the book mints the USDC it pays with).
    function _bid(PeripheryBook b, uint32 price, uint96 size) internal {
        b.addBid(price, size);
    }

    /// Gives `who` `amount` of `m`'s YES or NO by minting sets as the maker and transferring.
    function _giveTokens(Market m, address who, Side side, uint256 amount) internal {
        vm.startPrank(maker);
        vault.mintSets(address(m), amount, maker);
        OutcomeToken t = side == Side.Yes ? _yes(m) : _no(m);
        t.transfer(who, amount);
        vm.stopPrank();
    }

    function _usdcBalance(address who) internal view returns (uint256) {
        return usdc.balanceOf(who);
    }
}
