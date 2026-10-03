// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IKuruMarginAccount} from "../../src/interfaces/external/IKuruMarginAccount.sol";
import {KuruMarketParams} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {IKuruRouter} from "../../src/interfaces/external/IKuruRouter.sol";
import {MockKuruMarginAccount} from "../mocks/MockKuruMarginAccount.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";
import {MockKuruRouter} from "../mocks/MockKuruRouter.sol";
import {MockFactoryForRouter, MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {MockTokenForRouter} from "../mocks/MockVaultForRouter.sol";

contract GraduatorTest is Test {
    event BookCreated(address indexed market, address indexed book);
    event BookRegistered(address indexed market, address indexed book, address registrar);

    uint128 internal constant POOL_CAP = 5000e6;

    MockTokenForRouter internal usdc;
    MockTokenForRouter internal yes;
    MockTokenForRouter internal no;
    MockFactoryForRouter internal factory;
    MockMarketForRouter internal market;
    MockKuruMarginAccount internal ma;
    MockKuruRouter internal kuru;
    Graduator internal grad;

    address internal anyone = makeAddr("anyone");
    address internal griefer = makeAddr("griefer");

    function setUp() public {
        usdc = new MockTokenForRouter("USD Coin", "USDC", 6);
        yes = new MockTokenForRouter("YES", "YES", 6);
        no = new MockTokenForRouter("NO", "NO", 6);
        factory = new MockFactoryForRouter(makeAddr("vault"), address(usdc));
        market = new MockMarketForRouter(address(yes), address(no), POOL_CAP);
        factory.setMarket(address(market), true);
        ma = new MockKuruMarginAccount();
        kuru = new MockKuruRouter(ma);
        ma.setRouter(address(kuru));
        grad = _graduator(true, _params());
    }

    // ---------------------------------------------------------------- helpers

    function _params() internal pure returns (IGraduator.BookParams memory) {
        return IGraduator.BookParams({
            sizePrecision: 1e6,
            pricePrecision: 1e6,
            tickSize: 1000,
            minSize: 1e6,
            takerFeeBps: 30,
            makerFeeBps: 10,
            kuruAmmSpread: 30
        });
    }

    function _graduator(bool canCreate, IGraduator.BookParams memory p) internal returns (Graduator) {
        return new Graduator(
            IHunchBookFactory(address(factory)),
            IKuruRouter(address(kuru)),
            IKuruMarginAccount(address(ma)),
            address(usdc),
            canCreate,
            p
        );
    }

    /// Deploys a book through Kuru (as `caller`) with the default parameters, overridden by `p`.
    function _kuruBook(address caller, address base, address quote, IGraduator.BookParams memory p, uint96 maxSize)
        internal
        returns (address)
    {
        vm.prank(caller);
        return kuru.deployProxy(
            0,
            base,
            quote,
            p.sizePrecision,
            p.pricePrecision,
            p.tickSize,
            p.minSize,
            maxSize,
            p.takerFeeBps,
            p.makerFeeBps,
            p.kuruAmmSpread
        );
    }

    function _canonicalBook(address caller) internal returns (address) {
        return _kuruBook(caller, address(yes), address(usdc), _params(), uint96(POOL_CAP));
    }

    /// External so `vm.expectRevert` covers exactly this deployment and the test carries on after it
    /// (an expected revert on a bare `new` ends the test function in this Foundry version).
    function deployGraduator(address f, address r, address m, address u, IGraduator.BookParams memory p)
        external
        returns (Graduator)
    {
        return new Graduator(IHunchBookFactory(f), IKuruRouter(r), IKuruMarginAccount(m), u, true, p);
    }

    function _expectConstructorRevert(IGraduator.BookParams memory p) internal {
        vm.expectRevert(Graduator.InvalidBookParams.selector);
        this.deployGraduator(address(factory), address(kuru), address(ma), address(usdc), p);
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_storesConfig() public view {
        assertEq(address(grad.factory()), address(factory));
        assertEq(address(grad.kuruRouter()), address(kuru));
        assertEq(address(grad.kuruMarginAccount()), address(ma));
        assertEq(grad.usdc(), address(usdc));
        assertTrue(grad.canCreateBooks());
        IGraduator.BookParams memory p = grad.bookParams();
        assertEq(p.sizePrecision, 1e6);
        assertEq(p.pricePrecision, 1e6);
        assertEq(p.tickSize, 1000);
        assertEq(p.minSize, 1e6);
        assertEq(p.takerFeeBps, 30);
        assertEq(p.makerFeeBps, 10);
        assertEq(p.kuruAmmSpread, 30);
        assertEq(grad.bookOf(address(market)), address(0));
    }

    function test_constructor_mainnetMode() public {
        assertFalse(_graduator(false, _params()).canCreateBooks());
    }

    function test_constructor_revertsZeroAddresses() public {
        IGraduator.BookParams memory p = _params();
        vm.expectRevert(Graduator.ZeroAddress.selector);
        this.deployGraduator(address(0), address(kuru), address(ma), address(usdc), p);
        vm.expectRevert(Graduator.ZeroAddress.selector);
        this.deployGraduator(address(factory), address(0), address(ma), address(usdc), p);
        vm.expectRevert(Graduator.ZeroAddress.selector);
        this.deployGraduator(address(factory), address(kuru), address(0), address(usdc), p);
        vm.expectRevert(Graduator.ZeroAddress.selector);
        this.deployGraduator(address(factory), address(kuru), address(ma), address(0), p);
        // Control: the same call with every address set deploys.
        assertEq(
            this.deployGraduator(address(factory), address(kuru), address(ma), address(usdc), p).usdc(), address(usdc)
        );
    }

    function test_constructor_revertsCollateralMismatch() public {
        MockTokenForRouter other = new MockTokenForRouter("Other", "OTH", 6);
        vm.expectRevert(Graduator.CollateralMismatch.selector);
        this.deployGraduator(address(factory), address(kuru), address(ma), address(other), _params());
    }

    function test_constructor_revertsBadPrecisions() public {
        IGraduator.BookParams memory p = _params();
        p.sizePrecision = 0;
        _expectConstructorRevert(p);
        p.sizePrecision = 2e6;
        _expectConstructorRevert(p);
        p.sizePrecision = 1e7; // a power of ten, but not one YES base unit
        _expectConstructorRevert(p);

        p = _params();
        p.pricePrecision = 0;
        _expectConstructorRevert(p);
        p.pricePrecision = 15;
        _expectConstructorRevert(p);
        p.pricePrecision = 1e8; // a power of ten, but not one USDC base unit
        _expectConstructorRevert(p);
    }

    function test_constructor_revertsBadTickOrMinSize() public {
        IGraduator.BookParams memory p = _params();
        p.tickSize = 0;
        _expectConstructorRevert(p);
        p = _params();
        p.minSize = 0;
        _expectConstructorRevert(p);
    }

    function test_constructor_revertsBadFees() public {
        IGraduator.BookParams memory p = _params();
        p.makerFeeBps = 31; // maker above taker
        _expectConstructorRevert(p);
        p.takerFeeBps = 10_000;
        p.makerFeeBps = 0;
        _expectConstructorRevert(p);
        p.takerFeeBps = 9999;
        p.makerFeeBps = 9999;
        assertEq(_graduator(true, p).bookParams().takerFeeBps, 9999);
    }

    function test_constructor_revertsBadSpread() public {
        IGraduator.BookParams memory p = _params();
        p.kuruAmmSpread = 0;
        _expectConstructorRevert(p);
        p.kuruAmmSpread = 35;
        _expectConstructorRevert(p);
        p.kuruAmmSpread = 500;
        _expectConstructorRevert(p);
        p.kuruAmmSpread = 490;
        assertEq(_graduator(true, p).bookParams().kuruAmmSpread, 490);
        p.kuruAmmSpread = 10;
        assertEq(_graduator(true, p).bookParams().kuruAmmSpread, 10);
    }

    /// Whatever the constructor accepts, Kuru accepts too: `createBook` never fails on parameters.
    function testFuzz_constructor_acceptedParamsAlwaysDeploy(
        uint32 tickSize,
        uint96 minSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 spread
    ) public {
        minSize = uint96(bound(minSize, 0, POOL_CAP));
        takerFeeBps = bound(takerFeeBps, 0, 10_100);
        makerFeeBps = bound(makerFeeBps, 0, 10_100);
        spread = uint96(bound(spread, 0, 600));
        IGraduator.BookParams memory p =
            IGraduator.BookParams(1e6, 1e6, tickSize, minSize, takerFeeBps, makerFeeBps, spread);

        bool valid = tickSize != 0 && minSize != 0 && makerFeeBps <= takerFeeBps && takerFeeBps < 10_000
            && spread % 10 == 0 && spread != 0 && spread < 500;
        if (!valid) {
            _expectConstructorRevert(p);
            return;
        }
        Graduator g = _graduator(true, p);
        if (minSize >= POOL_CAP) {
            vm.expectRevert(Graduator.InvalidPoolCap.selector);
            g.createBook(address(market));
            return;
        }
        address book = g.createBook(address(market));
        assertEq(g.bookOf(address(market)), book);
    }

    // ---------------------------------------------------------------- createBook

    function test_createBook_deploysVerifiedBook() public {
        address predicted = kuru.computeAddress(
            address(yes), address(usdc), 1e6, 1e6, 1000, 1e6, uint96(POOL_CAP), 30, 10, 30, address(0), false
        );
        vm.expectEmit(address(grad));
        emit BookCreated(address(market), predicted);
        vm.prank(anyone);
        address book = grad.createBook(address(market));

        assertEq(book, predicted);
        assertEq(grad.bookOf(address(market)), book);
        assertTrue(ma.verifiedMarket(book));
        assertEq(kuru.deployCount(), 1);
        (
            uint32 pP,
            uint96 sP,
            address base,,
            address quote,,
            uint32 tick,
            uint96 minS,
            uint96 maxS,
            uint256 taker,
            uint256 maker
        ) = MockKuruOrderBook(book).getMarketParams();
        assertEq(pP, 1e6);
        assertEq(sP, 1e6);
        assertEq(base, address(yes));
        assertEq(quote, address(usdc));
        assertEq(tick, 1000);
        assertEq(minS, 1e6);
        assertEq(maxS, POOL_CAP);
        assertEq(taker, 30);
        assertEq(maker, 10);
        assertEq(MockKuruOrderBook(book).kuruAmmSpread(), 30);
    }

    function test_createBook_maxSizeIsThePoolCap() public {
        market.setPoolCap(1_234_567_890);
        address book = grad.createBook(address(market));
        (,,,,,,,, uint96 maxS,,) = MockKuruOrderBook(book).getMarketParams();
        assertEq(maxS, 1_234_567_890);
    }

    function test_createBook_revertsUnknownMarket() public {
        MockMarketForRouter stranger = new MockMarketForRouter(address(yes), address(no), POOL_CAP);
        vm.expectRevert(IGraduator.UnknownMarket.selector);
        grad.createBook(address(stranger));
    }

    function test_createBook_revertsBookExists() public {
        grad.createBook(address(market));
        vm.expectRevert(IGraduator.BookExists.selector);
        grad.createBook(address(market));
    }

    function test_createBook_revertsWhereCreationIsNotSupported() public {
        Graduator mainnet = _graduator(false, _params());
        vm.expectRevert(IGraduator.CreationNotSupported.selector);
        mainnet.createBook(address(market));
    }

    function test_createBook_revertsBadPoolCap() public {
        market.setPoolCap(1e6); // equal to minSize: Kuru needs maxSize > minSize
        vm.expectRevert(Graduator.InvalidPoolCap.selector);
        grad.createBook(address(market));
        market.setPoolCap(uint128(type(uint96).max) + 1);
        vm.expectRevert(Graduator.InvalidPoolCap.selector);
        grad.createBook(address(market));
    }

    /// Someone deploys our exact book first (deployProxy is open on testnet). Our own deployProxy would
    /// collide, so createBook adopts the existing book after verifying it.
    function test_createBook_adoptsFrontRunBook() public {
        address front = _canonicalBook(griefer);
        assertEq(kuru.deployCount(), 1);

        vm.expectEmit(address(grad));
        emit BookRegistered(address(market), front, anyone);
        vm.prank(anyone);
        address book = grad.createBook(address(market));

        assertEq(book, front);
        assertEq(grad.bookOf(address(market)), front);
        assertEq(kuru.deployCount(), 1);
    }

    /// The collision itself: a second identical deployProxy reverts, which is why createBook checks first.
    function test_kuruCollisionRevertsWithoutAdoption() public {
        _canonicalBook(griefer);
        vm.expectRevert();
        _canonicalBook(anyone);
    }

    // ---------------------------------------------------------------- registerBook

    function test_registerBook_mainnetFlow() public {
        Graduator mainnet = _graduator(false, _params());
        kuru.setOwnerOnly(true);
        vm.expectRevert(MockKuruRouter.Unauthorized.selector);
        _canonicalBook(anyone);

        address book = _canonicalBook(address(this)); // Kuru's owner creates it
        vm.expectEmit(address(mainnet));
        emit BookRegistered(address(market), book, anyone);
        vm.prank(anyone);
        mainnet.registerBook(address(market), book);
        assertEq(mainnet.bookOf(address(market)), book);

        vm.expectRevert(IGraduator.BookExists.selector);
        mainnet.registerBook(address(market), book);
    }

    function test_registerBook_recoversFrontRunOnTestnet() public {
        address front = _canonicalBook(griefer);
        grad.registerBook(address(market), front);
        assertEq(grad.bookOf(address(market)), front);
        vm.expectRevert(IGraduator.BookExists.selector);
        grad.createBook(address(market));
    }

    function test_registerBook_revertsUnknownMarket() public {
        address book = _canonicalBook(address(this));
        vm.expectRevert(IGraduator.UnknownMarket.selector);
        grad.registerBook(makeAddr("notAMarket"), book);
    }

    function test_registerBook_revertsAfterCreate() public {
        address book = grad.createBook(address(market));
        vm.expectRevert(IGraduator.BookExists.selector);
        grad.registerBook(address(market), book);
    }

    function test_registerBook_rejectsNonBooks() public {
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), address(0));
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), makeAddr("eoa"));
        // Verified in the MarginAccount but not a book (getMarketParams fails).
        ma.setRouter(address(this));
        ma.updateMarkets(address(usdc));
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), address(usdc));
    }

    /// A book with every right parameter that Kuru's Router did not create.
    function test_registerBook_rejectsUnverifiedBook() public {
        KuruMarketParams memory p =
            KuruMarketParams(1e6, 1e6, address(yes), 6, address(usdc), 6, 1000, 1e6, uint96(POOL_CAP), 30, 10);
        MockKuruOrderBook fake = new MockKuruOrderBook(p, 30);
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), address(fake));
    }

    function test_registerBook_rejectsWrongAssets() public {
        MockTokenForRouter otherYes = new MockTokenForRouter("YES2", "YES2", 6);
        address wrongBase = _kuruBook(address(this), address(otherYes), address(usdc), _params(), uint96(POOL_CAP));
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), wrongBase);

        MockTokenForRouter otherUsdc = new MockTokenForRouter("USDC2", "USDC2", 6);
        address wrongQuote = _kuruBook(address(this), address(yes), address(otherUsdc), _params(), uint96(POOL_CAP));
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), wrongQuote);

        // NO as the base.
        address noBook = _kuruBook(address(this), address(no), address(usdc), _params(), uint96(POOL_CAP));
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), noBook);
    }

    function test_registerBook_rejectsEachWrongParameter() public {
        IGraduator.BookParams memory p;

        p = _params();
        p.sizePrecision = 1e5;
        _expectMismatch(p, uint96(POOL_CAP));

        p = _params();
        p.pricePrecision = 1e8;
        _expectMismatch(p, uint96(POOL_CAP));

        p = _params();
        p.tickSize = 100;
        _expectMismatch(p, uint96(POOL_CAP));

        p = _params();
        p.minSize = 2e6;
        _expectMismatch(p, uint96(POOL_CAP));

        p = _params();
        _expectMismatch(p, uint96(POOL_CAP) - 1); // maxSize != pool cap

        p = _params();
        p.takerFeeBps = 9999; // a taker fee that would hand trades to a rebating maker
        p.makerFeeBps = 9999;
        _expectMismatch(p, uint96(POOL_CAP));

        p = _params();
        p.makerFeeBps = 0;
        _expectMismatch(p, uint96(POOL_CAP));

        p = _params();
        p.kuruAmmSpread = 40;
        _expectMismatch(p, uint96(POOL_CAP));
    }

    function test_registerBook_rejectsWrongDecimals() public {
        // A market whose YES token has 18 decimals: sizePrecision 1e6 would not be one base unit.
        MockTokenForRouter yes18 = new MockTokenForRouter("YES18", "YES18", 18);
        MockMarketForRouter m18 = new MockMarketForRouter(address(yes18), address(no), POOL_CAP);
        factory.setMarket(address(m18), true);
        address book = _kuruBook(address(this), address(yes18), address(usdc), _params(), uint96(POOL_CAP));
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(m18), book);
        // And createBook deploys it but refuses to record it.
        Graduator fresh = _graduator(true, _params());
        MockMarketForRouter m18b =
            new MockMarketForRouter(address(new MockTokenForRouter("Y", "Y", 18)), address(no), POOL_CAP);
        factory.setMarket(address(m18b), true);
        vm.expectRevert(IGraduator.BookMismatch.selector);
        fresh.createBook(address(m18b));
    }

    function test_holdsNoFunds() public {
        (bool ok,) = address(grad).call{value: 1}("");
        assertFalse(ok);
        grad.createBook(address(market));
        assertEq(address(grad).balance, 0);
        assertEq(usdc.balanceOf(address(grad)), 0);
        assertEq(yes.balanceOf(address(grad)), 0);
    }

    function _expectMismatch(IGraduator.BookParams memory p, uint96 maxSize) internal {
        uint256 snap = vm.snapshotState();
        address book = _kuruBook(address(this), address(yes), address(usdc), p, maxSize);
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), book);
        vm.revertToState(snap);
    }
}
