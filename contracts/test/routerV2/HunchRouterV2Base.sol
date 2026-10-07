// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HunchRouterV2} from "../../src/core/HunchRouterV2.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Phase} from "../../src/interfaces/IHunchBookTypes.sol";
import {IKuruAccountCore, KuruSwapResult} from "../../src/interfaces/external/IKuruV2.sol";
import {MockFactoryForRouter, MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {
    MockKuruAccountCoreV2,
    MockKuruSpotOrderBookV2,
    MockKuruSpotRouterV2,
    MockKuruWithdrawalLimiterV2
} from "../mocks/MockKuruV2.sol";
import {MockTokenForRouter, MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";

/// Shared fixture: one graduated market wired to a mock Kuru v2 book (deployed through the mock
/// SpotRouter, so AccountCore knows it), a mock vault and HunchRouterV2. A maker account rests the
/// liquidity tests add with `_ask` and `_bid`.
abstract contract HunchRouterV2Base is Test {
    uint128 internal constant POOL_CAP = 5000e6;
    uint256 internal constant VAULT_FLOAT = 1_000_000e6;

    MockTokenForRouter internal usdc;
    MockTokenForRouter internal yes;
    MockTokenForRouter internal no;
    MockVaultForRouter internal vault;
    MockFactoryForRouter internal factory;
    MockMarketForRouter internal market;
    MockKuruAccountCoreV2 internal core;
    MockKuruSpotRouterV2 internal spotRouter;
    MockKuruWithdrawalLimiterV2 internal limiter;
    MockKuruSpotOrderBookV2 internal book;
    HunchRouterV2 internal router;
    uint40 internal makerId;

    address internal alice = makeAddr("alice");
    address internal maker = makeAddr("maker");
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

        core = new MockKuruAccountCoreV2();
        spotRouter = new MockKuruSpotRouterV2(core);
        core.setSpotRouter(address(spotRouter));
        limiter = new MockKuruWithdrawalLimiterV2();
        core.setWithdrawalLimiter(address(limiter));
        core.configureSpotToken(address(usdc), true);
        core.configureSpotToken(address(yes), true);
        makerId = core.ensureRootAccount(maker);

        _useBook(0);
        router = new HunchRouterV2(IHunchBookFactory(address(factory)), IKuruAccountCore(address(core)));
        // Anyone can open an account for an owner by depositing to it; doing it here lets tests set the
        // router's fee tier before its first trade (HunchRouterV2YesTest covers a router with no account).
        core.deposit(address(router), address(usdc), 0);
        usdc.mint(address(vault), VAULT_FLOAT);
        deadline = block.timestamp + 1 hours;
    }

    /// A fresh book with `takerFeePps` (parts per 10^7) for the market.
    /// The same parameters always give the same address (CREATE2), so an existing book is emptied and reused.
    function _useBook(uint256 takerFeePps) internal {
        address at = spotRouter.computeAddress(
            address(yes), address(usdc), 1e6, 1e6, 1000, 10, 1e6, uint96(POOL_CAP), takerFeePps, 0
        );
        if (at.code.length != 0) {
            book = MockKuruSpotOrderBookV2(at);
            book.clear();
        } else {
            book = MockKuruSpotOrderBookV2(
                spotRouter.deploySpotMarket(
                    address(yes), address(usdc), 1e6, 1e6, 1000, 10, 1e6, uint96(POOL_CAP), takerFeePps, 0
                )
            );
        }
        book.setMaker(makerId);
        market.setBook(address(book));
    }

    /// Rests an ask: the maker deposits the YES.
    function _ask(uint32 price, uint96 size) internal {
        _fundMaker(yes, size);
        book.addAsk(price, size);
    }

    /// Rests a bid: the maker deposits the USDC (rounded up).
    function _bid(uint32 price, uint96 size) internal {
        _fundMaker(usdc, (uint256(price) * size + 1e6 - 1) / 1e6);
        book.addBid(price, size);
    }

    function _fundMaker(MockTokenForRouter token, uint256 amount) internal {
        token.mint(maker, amount);
        vm.startPrank(maker);
        token.approve(address(core), amount);
        core.deposit(makerId, address(token), amount);
        vm.stopPrank();
    }

    function _give(MockTokenForRouter token, address to, uint256 amount) internal {
        token.mint(to, amount);
        vm.prank(to);
        token.approve(address(router), type(uint256).max);
    }

    function _estimate(bool isBuy, uint256 amountIn) internal view returns (KuruSwapResult memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return book.estimateSwap(_routerAccount(), isBuy, uint128(amountIn));
    }

    /// The router's Kuru account (Kuru's record; the router caches it on its first trade).
    function _routerAccount() internal view returns (uint40) {
        return core.rootAccountIdOf(address(router));
    }

    /// The router and its Kuru account hold nothing, and the router has no standing approvals.
    function _assertRouterClean() internal view {
        address r = address(router);
        uint40 id = _routerAccount();
        assertEq(usdc.balanceOf(r), 0, "router USDC");
        assertEq(yes.balanceOf(r), 0, "router YES");
        assertEq(no.balanceOf(r), 0, "router NO");
        assertEq(core.getBalance(id, address(usdc)), 0, "Kuru account USDC");
        assertEq(core.getBalance(id, address(yes)), 0, "Kuru account YES");
        assertEq(usdc.allowance(r, address(core)), 0, "USDC allowance to AccountCore");
        assertEq(yes.allowance(r, address(core)), 0, "YES allowance to AccountCore");
        assertEq(usdc.allowance(r, address(vault)), 0, "USDC allowance to vault");
        assertEq(yes.allowance(r, address(vault)), 0, "YES allowance to vault");
        assertEq(no.allowance(r, address(vault)), 0, "NO allowance to vault");
    }

    /// Up to 12 ask levels from `seed`: increasing prices (multiples of 0.001, below 1 USDC), sizes 1 to 500 YES.
    function _randomAsks(uint256 seed) internal returns (uint256 total) {
        uint256 n = 1 + seed % 12;
        uint256 price = 1000 * (1 + (seed >> 8) % 400);
        for (uint256 i; i < n; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            uint256 size = 1e6 + h % 500e6;
            // forge-lint: disable-next-line(unsafe-typecast)
            _ask(uint32(price), uint96(size));
            total += size;
            price += 1000 * (1 + (h >> 128) % 50);
            if (price >= 1e6) break;
        }
    }

    /// Up to 12 bid levels from `seed`: decreasing prices below 1 USDC, sizes 1 to 500 YES.
    function _randomBids(uint256 seed) internal returns (uint256 total) {
        uint256 n = 1 + seed % 12;
        uint256 price = 1000 * (500 + (seed >> 8) % 499);
        for (uint256 i; i < n; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i, "bid")));
            uint256 size = 1e6 + h % 500e6;
            // forge-lint: disable-next-line(unsafe-typecast)
            _bid(uint32(price), uint96(size));
            total += size;
            uint256 step = 1000 * (1 + (h >> 128) % 50);
            if (price <= step) break;
            price -= step;
        }
    }
}
