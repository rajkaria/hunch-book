// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {GraduatorV2} from "../../src/core/GraduatorV2.sol";
import {IGraduatorV2} from "../../src/interfaces/IGraduatorV2.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IKuruAccountCore, IKuruSpotRouter} from "../../src/interfaces/external/IKuruV2.sol";
import {MockFactoryForRouter, MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {
    MockKuruAccountCoreV2,
    MockKuruSpotOrderBookV2,
    MockKuruSpotRouterV2,
    MockKuruWithdrawalLimiterV2
} from "../mocks/MockKuruV2.sol";
import {MockTokenForRouter} from "../mocks/MockVaultForRouter.sol";

contract GraduatorV2Test is Test {
    event BookRegistered(address indexed market, address indexed book, address registrar);

    uint128 internal constant POOL_CAP = 5000e6;

    MockTokenForRouter internal usdc;
    MockTokenForRouter internal yes;
    MockTokenForRouter internal no;
    MockFactoryForRouter internal factory;
    MockMarketForRouter internal market;
    MockKuruAccountCoreV2 internal core;
    MockKuruSpotRouterV2 internal kuru;
    MockKuruWithdrawalLimiterV2 internal limiter;
    GraduatorV2 internal grad;

    address internal anyone = makeAddr("anyone");
    address internal feed = makeAddr("feed");

    function setUp() public {
        usdc = new MockTokenForRouter("USD Coin", "USDC", 6);
        yes = new MockTokenForRouter("YES", "YES", 6);
        no = new MockTokenForRouter("NO", "NO", 6);
        factory = new MockFactoryForRouter(makeAddr("vault"), address(usdc));
        market = new MockMarketForRouter(address(yes), address(no), POOL_CAP);
        factory.setMarket(address(market), true);
        core = new MockKuruAccountCoreV2();
        kuru = new MockKuruSpotRouterV2(core);
        limiter = new MockKuruWithdrawalLimiterV2();
        core.setWithdrawalLimiter(address(limiter));
        grad = _graduator(_requested(), _limits());
        _setUpTokens(address(yes));
    }

    // ---------------------------------------------------------------- helpers

    function _requested() internal pure returns (IGraduatorV2.RequestedParams memory) {
        return IGraduatorV2.RequestedParams({
            sizePrecision: 1e6,
            pricePrecision: 1e6,
            tickSize: 1000,
            passiveSpreadTicks: 10,
            minQuoteNotional: 1e6,
            takerFeePps: 7000,
            makerFeePps: 4000
        });
    }

    function _limits() internal pure returns (IGraduatorV2.Limits memory) {
        return IGraduatorV2.Limits({maxTickSize: 10_000, maxMinQuoteNotional: 10e6, maxTakerFeePps: 20_000});
    }

    function _graduator(IGraduatorV2.RequestedParams memory r, IGraduatorV2.Limits memory l)
        internal
        returns (GraduatorV2)
    {
        return new GraduatorV2(
            IHunchBookFactory(address(factory)),
            IKuruSpotRouter(address(kuru)),
            IKuruAccountCore(address(core)),
            address(usdc),
            r,
            l
        );
    }

    /// Kuru's per-token setup: enabled in AccountCore and priced in the limiter.
    function _setUpTokens(address base) internal {
        core.configureSpotToken(base, true);
        core.configureSpotToken(address(usdc), true);
        limiter.setPriceSource(base, feed);
        limiter.setPriceSource(address(usdc), feed);
    }

    /// Kuru governance deploys a book from the request, with the given overrides applied.
    function _kuruBook(IGraduatorV2.BookRequest memory r) internal returns (address) {
        return kuru.deploySpotMarket(
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
        );
    }

    function _request() internal view returns (IGraduatorV2.BookRequest memory) {
        return grad.bookRequest(address(market));
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_storesEverything() public view {
        assertEq(address(grad.factory()), address(factory));
        assertEq(address(grad.spotRouter()), address(kuru));
        assertEq(address(grad.accountCore()), address(core));
        assertEq(grad.usdc(), address(usdc));
        assertEq(grad.kuruVersion(), 2);
        assertFalse(grad.canCreateBooks());
        IGraduatorV2.RequestedParams memory r = grad.requestedParams();
        assertEq(r.sizePrecision, 1e6);
        assertEq(r.pricePrecision, 1e6);
        assertEq(r.tickSize, 1000);
        assertEq(r.passiveSpreadTicks, 10);
        assertEq(r.minQuoteNotional, 1e6);
        assertEq(r.takerFeePps, 7000);
        assertEq(r.makerFeePps, 4000);
        IGraduatorV2.Limits memory l = grad.limits();
        assertEq(l.maxTickSize, 10_000);
        assertEq(l.maxMinQuoteNotional, 10e6);
        assertEq(l.maxTakerFeePps, 20_000);
    }

    function deploy(address f, address r, address c, address u) external returns (GraduatorV2) {
        return
            new GraduatorV2(IHunchBookFactory(f), IKuruSpotRouter(r), IKuruAccountCore(c), u, _requested(), _limits());
    }

    function deployWith(IGraduatorV2.RequestedParams memory r, IGraduatorV2.Limits memory l)
        external
        returns (GraduatorV2)
    {
        return _graduator(r, l);
    }

    function test_constructor_revertsZeroAddresses() public {
        vm.expectRevert(GraduatorV2.ZeroAddress.selector);
        this.deploy(address(0), address(kuru), address(core), address(usdc));
        vm.expectRevert(GraduatorV2.ZeroAddress.selector);
        this.deploy(address(factory), address(0), address(core), address(usdc));
        vm.expectRevert(GraduatorV2.ZeroAddress.selector);
        this.deploy(address(factory), address(kuru), address(0), address(usdc));
        vm.expectRevert(GraduatorV2.ZeroAddress.selector);
        this.deploy(address(factory), address(kuru), address(core), address(0));
        vm.expectRevert(GraduatorV2.CollateralMismatch.selector);
        this.deploy(address(factory), address(kuru), address(core), address(yes));
    }

    function test_constructor_revertsEachBadParameter() public {
        IGraduatorV2.RequestedParams memory r;
        IGraduatorV2.Limits memory l;

        r = _requested();
        r.sizePrecision = 1e5;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        r = _requested();
        r.pricePrecision = 1e8;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        l = _limits();
        l.maxTakerFeePps = 100_001;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(_requested(), l);

        l = _limits();
        l.maxTickSize = 0;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(_requested(), l);

        r = _requested();
        r.tickSize = 0;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        r = _requested();
        r.tickSize = 10_001;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        r = _requested();
        r.makerFeePps = 7001;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        r = _requested();
        r.takerFeePps = 20_001;
        r.makerFeePps = 0;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        r = _requested();
        r.minQuoteNotional = 0;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        r = _requested();
        r.minQuoteNotional = 10e6 + 1;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());

        r = _requested();
        r.passiveSpreadTicks = 0;
        vm.expectRevert(GraduatorV2.InvalidParams.selector);
        this.deployWith(r, _limits());
    }

    // ---------------------------------------------------------------- request and prediction

    function test_bookRequest_isTheRequestWithThePoolCap() public view {
        IGraduatorV2.BookRequest memory r = _request();
        assertEq(r.baseToken, address(yes));
        assertEq(r.quoteToken, address(usdc));
        assertEq(r.sizePrecision, 1e6);
        assertEq(r.pricePrecision, 1e6);
        assertEq(r.tickSize, 1000);
        assertEq(r.passiveSpreadTicks, 10);
        assertEq(r.minQuoteNotional, 1e6);
        assertEq(r.maxQuoteNotional, POOL_CAP);
        assertEq(r.takerFeePps, 7000);
        assertEq(r.makerFeePps, 4000);
    }

    function test_bookRequest_revertsUnknownMarketAndBadCap() public {
        vm.expectRevert(IGraduatorV2.UnknownMarket.selector);
        grad.bookRequest(makeAddr("stranger"));
        market.setPoolCap(1e6);
        vm.expectRevert(GraduatorV2.InvalidPoolCap.selector);
        grad.bookRequest(address(market));
        market.setPoolCap(uint128(type(uint96).max) + 1);
        vm.expectRevert(GraduatorV2.InvalidPoolCap.selector);
        grad.bookRequest(address(market));
    }

    function test_predictedBook_isWhereKuruDeploysTheRequest() public {
        address predicted = grad.predictedBook(address(market));
        assertEq(predicted.code.length, 0);
        assertEq(_kuruBook(_request()), predicted);
    }

    function test_createBook_alwaysReverts() public {
        vm.expectRevert(IGraduatorV2.CreationNotSupported.selector);
        grad.createBook(address(market));
    }

    // ---------------------------------------------------------------- registration

    function test_registerBook_theRequestedBook() public {
        address book = _kuruBook(_request());
        assertEq(uint8(grad.bookProblem(address(market), book)), uint8(IGraduatorV2.Problem.None));
        vm.expectEmit(address(grad));
        emit BookRegistered(address(market), book, anyone);
        vm.prank(anyone);
        grad.registerBook(address(market), book);
        assertEq(grad.bookOf(address(market)), book);

        vm.expectRevert(IGraduatorV2.BookExists.selector);
        grad.registerBook(address(market), book);
    }

    /// Kuru may settle on other parameters than we asked for: anything within the limits is accepted.
    function test_registerBook_acceptsKuruChoicesWithinLimits() public {
        IGraduatorV2.BookRequest memory r = _request();
        r.tickSize = 1;
        r.passiveSpreadTicks = 100;
        r.minQuoteNotional = 10e6;
        r.maxQuoteNotional = 5_000_000e6;
        r.takerFeePps = 20_000;
        r.makerFeePps = 20_000;
        address book = _kuruBook(r);
        grad.registerBook(address(market), book);
        assertEq(grad.bookOf(address(market)), book);
    }

    function test_registerBook_revertsUnknownMarket() public {
        address book = _kuruBook(_request());
        vm.expectRevert(IGraduatorV2.UnknownMarket.selector);
        grad.registerBook(makeAddr("stranger"), book);
        vm.expectRevert(IGraduatorV2.UnknownMarket.selector);
        grad.bookProblem(makeAddr("stranger"), book);
    }

    function _expectProblem(address book, IGraduatorV2.Problem p) internal {
        assertEq(uint8(grad.bookProblem(address(market), book)), uint8(p));
        vm.expectRevert(abi.encodeWithSelector(IGraduatorV2.BookMismatch.selector, p));
        grad.registerBook(address(market), book);
    }

    function test_rejects_noCode() public {
        _expectProblem(makeAddr("eoa"), IGraduatorV2.Problem.NoCode);
    }

    /// A look-alike book nobody at Kuru deployed.
    function test_rejects_bookKuruDidNotDeploy() public {
        IGraduatorV2.BookRequest memory r = _request();
        MockKuruSpotOrderBookV2 fake = new MockKuruSpotOrderBookV2(
            core,
            r.baseToken,
            r.quoteToken,
            r.sizePrecision,
            r.pricePrecision,
            r.tickSize,
            r.passiveSpreadTicks,
            r.minQuoteNotional,
            r.maxQuoteNotional,
            0,
            0
        );
        _expectProblem(address(fake), IGraduatorV2.Problem.NotVerifiedBySpotRouter);

        kuru.setVerified(address(fake), true);
        _expectProblem(address(fake), IGraduatorV2.Problem.NotRegisteredInAccountCore);
    }

    function test_rejects_otherTokens() public {
        IGraduatorV2.BookRequest memory r = _request();
        r.baseToken = address(no);
        _setUpTokens(address(no));
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.WrongTokens);

        r = _request();
        r.quoteToken = address(no);
        r.minQuoteNotional = 2e6;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.WrongTokens);
    }

    /// AccountCore's records disagree with what the book reports.
    function test_rejects_registryTokenMismatch() public {
        address book = _kuruBook(_request());
        core.registerSpotMarket(book, address(no), address(usdc));
        _expectProblem(book, IGraduatorV2.Problem.WrongTokens);
    }

    function test_rejects_otherAccountCore() public {
        MockKuruAccountCoreV2 other = new MockKuruAccountCoreV2();
        IGraduatorV2.BookRequest memory r = _request();
        MockKuruSpotOrderBookV2 b = new MockKuruSpotOrderBookV2(
            other,
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
        );
        kuru.setVerified(address(b), true);
        core.registerSpotMarket(address(b), address(yes), address(usdc));
        _expectProblem(address(b), IGraduatorV2.Problem.WrongAccountCore);
    }

    function test_rejects_otherPrecisions() public {
        IGraduatorV2.BookRequest memory r = _request();
        r.sizePrecision = 1e5;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.WrongPrecision);
        r = _request();
        r.pricePrecision = 1e8;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.WrongPrecision);
    }

    function test_rejects_tickOutsideLimits() public {
        IGraduatorV2.BookRequest memory r = _request();
        r.tickSize = 10_001;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.BadTickSize);
        r = _request();
        r.tickSize = 0;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.BadTickSize);
    }

    function test_rejects_feesOutsideLimits() public {
        IGraduatorV2.BookRequest memory r = _request();
        r.takerFeePps = 20_001;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.BadFees);
        r = _request();
        r.makerFeePps = 7001;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.BadFees);
    }

    function test_rejects_minNotionalAboveLimit() public {
        IGraduatorV2.BookRequest memory r = _request();
        r.minQuoteNotional = 10e6 + 1;
        _expectProblem(_kuruBook(r), IGraduatorV2.Problem.BadMinQuoteNotional);
    }

    function test_rejects_tokenNotEnabled() public {
        address book = _kuruBook(_request());
        core.configureSpotToken(address(yes), false);
        _expectProblem(book, IGraduatorV2.Problem.TokenNotEnabled);
        core.configureSpotToken(address(yes), true);
        core.configureSpotToken(address(usdc), false);
        _expectProblem(book, IGraduatorV2.Problem.TokenNotEnabled);
    }

    function test_rejects_noPriceSource() public {
        address book = _kuruBook(_request());
        limiter.setPriceSource(address(yes), address(0));
        _expectProblem(book, IGraduatorV2.Problem.NoPriceSource);
        limiter.setPriceSource(address(yes), feed);
        limiter.setPriceSource(address(usdc), address(0));
        _expectProblem(book, IGraduatorV2.Problem.NoPriceSource);
    }

    /// Without a bound limiter there is nothing to check there.
    function test_noLimiterSkipsThePriceSourceCheck() public {
        address book = _kuruBook(_request());
        core.setWithdrawalLimiter(address(0));
        limiter.setPriceSource(address(yes), address(0));
        grad.registerBook(address(market), book);
    }

    /// Fuzz: any parameters Kuru might choose are accepted exactly when they fall within the limits.
    function testFuzz_acceptsExactlyWithinLimits(uint32 tick, uint256 taker, uint256 maker, uint96 minQ) public {
        tick = uint32(bound(tick, 0, 20_000));
        taker = bound(taker, 0, 40_000);
        maker = bound(maker, 0, 40_000);
        minQ = uint96(bound(minQ, 1, 20e6));
        IGraduatorV2.BookRequest memory r = _request();
        r.tickSize = tick;
        r.takerFeePps = taker;
        r.makerFeePps = maker;
        r.minQuoteNotional = minQ;
        address book = _kuruBook(r);
        bool ok = tick != 0 && tick <= 10_000 && maker <= taker && taker <= 20_000 && minQ <= 10e6;
        assertEq(grad.bookProblem(address(market), book) == IGraduatorV2.Problem.None, ok);
    }

    function test_holdsNoFunds() public view {
        assertEq(address(grad).balance, 0);
        assertEq(usdc.balanceOf(address(grad)), 0);
    }
}
