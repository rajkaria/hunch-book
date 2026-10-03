// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Phase} from "../../src/interfaces/IHunchBookTypes.sol";
import {KuruMarketParams} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";
import {MockFactoryForRouter, MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {MockTokenForRouter, MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";

/// Shared fixture: one graduated market wired to a mock Kuru book, a mock vault and the router.
abstract contract HunchRouterBase is Test {
    uint128 internal constant POOL_CAP = 5000e6;
    uint256 internal constant VAULT_FLOAT = 1_000_000e6;

    MockTokenForRouter internal usdc;
    MockTokenForRouter internal yes;
    MockTokenForRouter internal no;
    MockVaultForRouter internal vault;
    MockFactoryForRouter internal factory;
    MockMarketForRouter internal market;
    MockKuruOrderBook internal book;
    HunchRouter internal router;

    address internal alice = makeAddr("alice");
    uint256 internal deadline;

    function setUp() public virtual {
        usdc = new MockTokenForRouter("USD Coin", "USDC", 6);
        yes = new MockTokenForRouter("YES", "YES", 6);
        no = new MockTokenForRouter("NO", "NO", 6);
        vault = new MockVaultForRouter(address(usdc));
        factory = new MockFactoryForRouter(address(vault), address(usdc));
        market = new MockMarketForRouter(address(yes), address(no), POOL_CAP);
        factory.setMarket(address(market), true);
        market.setPhase(Phase.Graduated);
        _useBook(0);
        router = new HunchRouter(IHunchBookFactory(address(factory)));
        // USDC the vault holds for pools and sets elsewhere: what flash loans draw on.
        usdc.mint(address(vault), VAULT_FLOAT);
        deadline = block.timestamp + 1 hours;
    }

    function _useBook(uint256 takerFeeBps) internal {
        KuruMarketParams memory p = KuruMarketParams({
            pricePrecision: 1e6,
            sizePrecision: 1e6,
            baseAsset: address(yes),
            baseAssetDecimals: 6,
            quoteAsset: address(usdc),
            quoteAssetDecimals: 6,
            tickSize: 1000,
            minSize: 1e6,
            maxSize: uint96(POOL_CAP),
            takerFeeBps: takerFeeBps,
            makerFeeBps: 0
        });
        book = new MockKuruOrderBook(p, 30);
        market.setBook(address(book));
    }

    function _give(MockTokenForRouter token, address to, uint256 amount) internal {
        token.mint(to, amount);
        vm.prank(to);
        token.approve(address(router), type(uint256).max);
    }

    /// The router holds nothing and has no standing approvals.
    function _assertRouterClean() internal view {
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(yes.balanceOf(address(router)), 0, "router YES");
        assertEq(no.balanceOf(address(router)), 0, "router NO");
        assertEq(usdc.allowance(address(router), address(book)), 0, "USDC allowance to book");
        assertEq(yes.allowance(address(router), address(book)), 0, "YES allowance to book");
        assertEq(no.allowance(address(router), address(book)), 0, "NO allowance to book");
        assertEq(usdc.allowance(address(router), address(vault)), 0, "USDC allowance to vault");
        assertEq(yes.allowance(address(router), address(vault)), 0, "YES allowance to vault");
        assertEq(no.allowance(address(router), address(vault)), 0, "NO allowance to vault");
    }

    /// Up to 12 ask levels from `seed`: strictly increasing prices (multiples of the 0.001 tick, below
    /// 1 USDC) and sizes from 1 to 500 YES. Returns the total size.
    function _randomAsks(uint256 seed) internal returns (uint256 total) {
        uint256 n = 1 + seed % 12;
        uint256 price = 1000 * (1 + (seed >> 8) % 400);
        for (uint256 i; i < n; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            uint256 size = 1e6 + h % 500e6;
            book.addAsk(uint32(price), uint96(size));
            total += size;
            price += 1000 * (1 + (h >> 128) % 50);
            if (price >= 1e6) break;
        }
    }

    /// Up to 12 bid levels from `seed`: strictly decreasing prices below 1 USDC, sizes 1 to 500 YES.
    function _randomBids(uint256 seed) internal returns (uint256 total) {
        uint256 n = 1 + seed % 12;
        uint256 price = 1000 * (500 + (seed >> 8) % 499);
        for (uint256 i; i < n; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i, "bid")));
            uint256 size = 1e6 + h % 500e6;
            book.addBid(uint32(price), uint96(size));
            total += size;
            uint256 step = 1000 * (1 + (h >> 128) % 50);
            if (price <= step) break;
            price -= step;
        }
    }
}
