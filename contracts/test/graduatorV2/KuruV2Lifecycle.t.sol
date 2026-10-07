// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {GraduatorV2} from "../../src/core/GraduatorV2.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {HunchRouterV2} from "../../src/core/HunchRouterV2.sol";
import {Market} from "../../src/core/Market.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IGraduatorV2} from "../../src/interfaces/IGraduatorV2.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Outcome, Phase, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {IKuruAccountCore, IKuruSpotRouter} from "../../src/interfaces/external/IKuruV2.sol";
import {BaseTest} from "../core/Base.t.sol";
import {
    MockKuruAccountCoreV2,
    MockKuruSpotOrderBookV2,
    MockKuruSpotRouterV2,
    MockKuruWithdrawalLimiterV2
} from "../mocks/MockKuruV2.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

/// The real core (factory, vault, markets) wired to GraduatorV2 and HunchRouterV2, with the mock Kuru v2
/// exchange standing in for Kuru: request, Kuru setup, registration, graduation, trading every path,
/// Kuru's soft pause at close, settlement and redemption.
contract KuruV2LifecycleTest is BaseTest {
    MockKuruAccountCoreV2 internal core;
    MockKuruSpotRouterV2 internal kuru;
    MockKuruWithdrawalLimiterV2 internal limiter;
    GraduatorV2 internal grad;
    HunchRouterV2 internal router;
    address internal maker = makeAddr("maker");
    uint40 internal makerId;

    /// Same as BaseTest.setUp, with GraduatorV2 wired instead of the mock graduator (wiring is one-time).
    function setUp() public override {
        vm.warp(1_800_000_000);
        vm.roll(50_000_000);

        usdc = new TestUSDC();
        marketImpl = new Market();
        factory =
            new HunchBookFactory(address(usdc), address(marketImpl), guardian, feeRecipient, _caps(), COLLATERAL_CAP);
        vault = CollateralVault(factory.vault());
        resolver = new MockResolver();

        core = new MockKuruAccountCoreV2();
        kuru = new MockKuruSpotRouterV2(core);
        limiter = new MockKuruWithdrawalLimiterV2();
        core.setWithdrawalLimiter(address(limiter));
        grad = new GraduatorV2(
            IHunchBookFactory(address(factory)),
            IKuruSpotRouter(address(kuru)),
            IKuruAccountCore(address(core)),
            address(usdc),
            IGraduatorV2.RequestedParams({
                sizePrecision: 1e6,
                pricePrecision: 1e6,
                tickSize: 1000,
                passiveSpreadTicks: 10,
                minQuoteNotional: 1e6,
                takerFeePps: 7000,
                makerFeePps: 4000
            }),
            IGraduatorV2.Limits({maxTickSize: 10_000, maxMinQuoteNotional: 10e6, maxTakerFeePps: 20_000})
        );
        factory.setGraduator(address(grad));
        router = new HunchRouterV2(IHunchBookFactory(address(factory)), IKuruAccountCore(address(core)));

        vm.prank(guardian);
        factory.addTemplate(TEMPLATE, IResolver(address(resolver)), _rule());

        for (uint256 i; i < 16; ++i) {
            address u = makeAddr(string.concat("user", vm.toString(i)));
            users.push(u);
            _fund(u, WALLET_CAP * 2);
        }
        _fund(creator, WALLET_CAP * 10);
        makerId = core.ensureRootAccount(maker);
    }

    /// Kuru's side of a request: whitelist and price both tokens, deploy the requested book.
    function _kuruSetup(Market m) internal returns (MockKuruSpotOrderBookV2 book) {
        IGraduatorV2.BookRequest memory r = grad.bookRequest(address(m));
        core.configureSpotToken(r.baseToken, true);
        core.configureSpotToken(r.quoteToken, true);
        limiter.setPriceSource(r.baseToken, makeAddr("yesFeed"));
        limiter.setPriceSource(r.quoteToken, makeAddr("usdcFeed"));
        book = MockKuruSpotOrderBookV2(
            kuru.deploySpotMarket(
                r.baseToken,
                r.quoteToken,
                r.sizePrecision,
                r.pricePrecision,
                r.tickSize,
                r.passiveSpreadTicks,
                r.minQuoteNotional,
                r.maxQuoteNotional,
                r.takerFeePps,
                r.makerFeePps
            )
        );
        book.setMaker(makerId);
        assertEq(address(book), grad.predictedBook(address(m)));
    }

    /// The maker mints sets through the vault and rests YES asks and bids around `mid`.
    function _quote(MockKuruSpotOrderBookV2 book, Market m, uint32 mid, uint96 size) internal {
        usdc.mint(maker, 10_000e6);
        vm.startPrank(maker);
        usdc.approve(address(vault), type(uint256).max);
        vault.mintSets(address(m), size, maker);
        _yes(m).approve(address(core), size);
        core.deposit(makerId, address(_yes(m)), size);
        usdc.approve(address(core), size);
        core.deposit(makerId, address(usdc), size);
        vm.stopPrank();
        book.addAsk(mid + 10_000, size);
        book.addBid(mid - 10_000, size);
    }

    function test_fullLifecycleOnKuruV2() public {
        Market m = _createDefault();
        _fillToRule(m);

        // The rule holds, but Kuru has not created the book yet: graduation waits.
        assertTrue(m.graduationRuleMet());
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();

        MockKuruSpotOrderBookV2 book = _kuruSetup(m);
        vm.prank(makeAddr("anyone"));
        grad.registerBook(address(m), address(book));
        m.graduate();
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        assertEq(m.book(), address(book));

        for (uint256 i; i < 10; ++i) {
            vm.prank(users[i]);
            m.claimTokens();
        }
        _quote(book, m, 500_000, 200e6);

        address trader = users[11];
        vm.startPrank(trader);
        usdc.approve(address(router), type(uint256).max);
        _yes(m).approve(address(router), type(uint256).max);
        _no(m).approve(address(router), type(uint256).max);
        uint256 yesBought = router.buyYes(address(m), 10e6, 0, block.timestamp);
        assertGt(yesBought, 0);
        router.sellYes(address(m), yesBought / 2, 0, block.timestamp);
        router.buyNo(address(m), 20e6, 20e6, block.timestamp);
        router.sellNo(address(m), 10e6, 0, block.timestamp);
        vm.stopPrank();

        _assertSolvent();
        _assertSetsMatchSupply(m);
        uint40 id = router.accountId();
        assertTrue(id != 0, "the first trade opened the router's Kuru account");
        assertEq(core.getBalance(id, address(usdc)), 0);
        assertEq(core.getBalance(id, address(_yes(m))), 0);

        // Close: Kuru soft-pauses the book; trades stop, settlement and redemption never depend on Kuru.
        _toClose(m);
        book.setMarketState(1);
        resolver.setAnswer(Outcome.No);
        m.settle("");
        assertEq(uint8(m.phase()), uint8(Phase.Settled));

        uint256 noHeld = _no(m).balanceOf(trader);
        assertGt(noHeld, 0);
        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        vault.redeem(address(m), Side.No, noHeld, trader);
        assertGt(usdc.balanceOf(trader), before);
        _assertSolvent();
    }

    /// A market whose book never arrives locks as a pool and settles as one: nothing is stuck.
    function test_bookThatNeverArrivesSettlesAsPool() public {
        Market m = _createDefault();
        _fillToRule(m);
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();
        vm.warp(m.window().lock);
        assertEq(uint8(m.phase()), uint8(Phase.PoolLocked));
        _settle(m, Outcome.Yes);
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        _assertSolvent();
    }
}
