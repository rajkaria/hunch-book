// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {GraduatorV2} from "../../src/core/GraduatorV2.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {HunchRouterV2} from "../../src/core/HunchRouterV2.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IGraduatorV2} from "../../src/interfaces/IGraduatorV2.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {GraduationRule, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {IKuruAccountCore, IKuruSpotRouter, IKuruWithdrawalLimiter} from "../../src/interfaces/external/IKuruV2.sol";
import {ImpliedProbabilityOracle} from "../../src/periphery/ImpliedProbabilityOracle.sol";
import {OutcomeTokenPriceAdapter} from "../../src/periphery/OutcomeTokenPriceAdapter.sol";
import {OutcomeTokenPriceAdapterFactory} from "../../src/periphery/OutcomeTokenPriceAdapterFactory.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployPeriphery} from "../../script/DeployPeriphery.s.sol";
import {WireKuruV2} from "../../script/WireKuruV2.s.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

/// Kuru's maker-side calls (not used by Hunch Book's contracts).
interface IKuruSpotOrderBookMaker {
    struct Order {
        uint8 side; // 0 buy, 1 sell
        uint96 quantity;
        uint32 price;
        uint8 tif; // 0 GTC, 1 IOC, 2 FOK
        uint8 executionInstruction; // 0 none, 1 post-only
        uint32 minSizeAfterBlock;
    }

    function batch(uint40 userId, Order[] calldata orders, uint8[] calldata cancelSlotIdxs) external;
    function cancelAllOrders(uint40 userId) external;
}

/// Stands in for the price-source contract Kuru wraps a Chainlink feed in (their testnet USDC source has
/// fetchPrice() at 1e18, maxPriceAge() and feed()). Ours wraps a Hunch Book limiter feed the same way.
contract KuruPriceSourceStub {
    OutcomeTokenPriceAdapter public immutable feed;
    uint32 public immutable maxPriceAge;

    constructor(OutcomeTokenPriceAdapter feed_, uint32 maxPriceAge_) {
        feed = feed_;
        maxPriceAge = maxPriceAge_;
    }

    function fetchPrice() external view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        require(block.timestamp - updatedAt <= maxPriceAge, "stale");
        require(answer > 0, "no price");
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(answer) * 1e10;
    }
}

/// The Kuru v2 path end to end on a fork of Monad testnet, against Kuru's live v2 contracts: a Hunch
/// Book v2 stack deployed with Deploy.s.sol and DeployPeriphery.s.sol, Kuru's setup steps done as Kuru's
/// owner would (price sources, enabling, whitelisting, deploySpotMarket with GraduatorV2's request),
/// registration, graduation, a maker resting orders through AccountCore, every HunchRouterV2 path through
/// Kuru's real AccountCore and WithdrawalLimiter, a soft pause at close, settlement and redemption.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path "test/fork/KuruV2*" -vv
contract KuruV2ForkTest is Test {
    uint32 internal constant TEMPLATE_TEST = 99;
    uint256 internal constant DEPLOYER_KEY = 0xD3B10;

    IKuruSpotRouter internal spotRouter;
    IKuruAccountCore internal core;
    IKuruWithdrawalLimiter internal limiter;
    address internal kuruOwner;
    address internal kuruUsdcSource;

    TestUSDC internal usdc;
    HunchBookFactory internal factory;
    CollateralVault internal vault;
    GraduatorV2 internal grad;
    HunchRouterV2 internal router;
    ImpliedProbabilityOracle internal oracle;
    OutcomeTokenPriceAdapterFactory internal feeds;
    MockResolver internal resolver;

    address internal deployer;
    address internal maker = makeAddr("maker");
    address internal trader = makeAddr("trader");
    address[] internal stakers;

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        spotRouter = IKuruSpotRouter(vm.parseJsonAddress(json, ".external.kuruV2.spotRouter"));
        core = IKuruAccountCore(vm.parseJsonAddress(json, ".external.kuruV2.accountCore"));
        limiter = IKuruWithdrawalLimiter(vm.parseJsonAddress(json, ".external.kuruV2.withdrawalLimiter"));
        kuruOwner = spotRouter.owner();
        kuruUsdcSource = limiter.priceSource(vm.parseJsonAddress(json, ".external.kuruV2.usdc"));
        assertEq(core.withdrawalLimiter(), address(limiter), "deployments file: limiter");

        // A v2 stack, deployed by the deploy scripts (an extra stack name nobody uses, so nothing is skipped).
        deployer = vm.addr(DEPLOYER_KEY);
        Deploy.Deployed memory d = new Deploy()
            .deployWith(
                DEPLOYER_KEY,
                deployer,
                deployer,
                Deploy.Options({kuruVersion: 2, stack: "forkTestV2", wireKuru: true, hunchVenue: false})
            );
        assertEq(d.kuruVersion, 2);
        usdc = TestUSDC(d.usdc);
        assertEq(d.usdc, vm.parseJsonAddress(json, ".hunchBook.usdc"), "v2 stack reuses the test USDC");
        factory = HunchBookFactory(d.factory);
        vault = CollateralVault(d.vault);
        grad = GraduatorV2(d.graduator);
        router = HunchRouterV2(d.router);
        assertEq(factory.graduator(), d.graduator);
        assertEq(grad.kuruVersion(), 2);

        DeployPeriphery p = new DeployPeriphery();
        DeployPeriphery.Config memory c = DeployPeriphery.Config({
            factory: d.factory,
            router: d.router,
            proposer: deployer,
            funder: deployer,
            timelockDelay: 2 days,
            kuruVersion: 2
        });
        DeployPeriphery.Deployed memory pd = p.deploy(DEPLOYER_KEY, c);
        oracle = ImpliedProbabilityOracle(pd.impliedProbabilityOracle);
        feeds = OutcomeTokenPriceAdapterFactory(pd.kuruFeedFactory);
        assertEq(oracle.kuruVersion(), 2);

        // A resolver this test controls, as template 99 (the deployer is the guardian on testnet).
        resolver = new MockResolver();
        vm.prank(deployer);
        factory.addTemplate(
            TEMPLATE_TEST,
            IResolver(address(resolver)),
            GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700})
        );
        for (uint256 i; i < 11; ++i) {
            stakers.push(makeAddr(string.concat("staker", vm.toString(i))));
        }
    }

    // ---------------------------------------------------------------- steps

    function _market() internal returns (Market m) {
        Window memory w;
        // Close within hours: warping days would make Kuru's own USDC price (a 25-hour maximum age on
        // testnet) stale on the fork, which no live chain would see.
        w.lock = uint64(block.timestamp + 2 hours);
        w.close = uint64(block.timestamp + 3 hours);
        w.settleDeadline = w.close + 7 days;
        _usdc(stakers[0], 50e6);
        vm.prank(stakers[0]);
        m = Market(payable(factory.createMarket(TEMPLATE_TEST, abi.encode(w), Side.Yes, 50e6)));
    }

    function _usdc(address who, uint256 amount) internal {
        deal(address(usdc), who, usdc.balanceOf(who) + amount);
        vm.startPrank(who);
        usdc.approve(address(vault), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// The pool meets the rule: 11 stakers, 300 YES / 250 NO.
    function _fill(Market m) internal {
        for (uint256 i = 1; i < 6; ++i) {
            _usdc(stakers[i], 50e6);
            vm.prank(stakers[i]);
            m.stake(Side.Yes, 50e6);
        }
        for (uint256 i = 6; i < 11; ++i) {
            _usdc(stakers[i], 50e6);
            vm.prank(stakers[i]);
            m.stake(Side.No, 50e6);
        }
    }

    function _pokeAfter(Market m, uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1);
        oracle.poke(address(m));
    }

    /// What Kuru does per market, as Kuru's owner: price sources, enabling, whitelisting, the book.
    function _kuruSetup(Market m, address yesFeed) internal returns (address book) {
        (address yes,) = m.tokens();
        KuruPriceSourceStub yesSource = new KuruPriceSourceStub(OutcomeTokenPriceAdapter(yesFeed), 1 hours);
        IGraduatorV2.BookRequest memory r = grad.bookRequest(address(m));
        vm.startPrank(kuruOwner);
        limiter.setPriceSource(yes, address(yesSource));
        limiter.setPriceSource(address(usdc), kuruUsdcSource);
        core.configureSpotToken(yes, true);
        core.configureSpotToken(address(usdc), true);
        spotRouter.whitelistSpotToken(yes, true);
        spotRouter.whitelistSpotToken(address(usdc), true);
        book = spotRouter.deploySpotMarket(
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
        vm.stopPrank();
    }

    /// The maker deposits into its Kuru account and rests a bid at `bid` and an ask at `ask` for `size` YES.
    function _rest(Market m, address book, uint32 bid, uint32 ask, uint96 size) internal returns (uint40 makerId) {
        (address yes,) = m.tokens();
        _usdc(maker, 2 * uint256(size));
        vm.startPrank(maker);
        vault.mintSets(address(m), size, maker);
        // Deposit by owner opens the maker's Kuru account.
        OutcomeToken(yes).approve(address(core), size);
        core.deposit(maker, yes, size);
        makerId = core.rootAccountIdOf(maker);
        usdc.approve(address(core), size);
        core.deposit(makerId, address(usdc), size);
        IKuruSpotOrderBookMaker.Order[] memory orders = new IKuruSpotOrderBookMaker.Order[](2);
        orders[0] = IKuruSpotOrderBookMaker.Order(0, size, bid, 0, 1, 0);
        orders[1] = IKuruSpotOrderBookMaker.Order(1, size, ask, 0, 1, 0);
        IKuruSpotOrderBookMaker(book).batch(makerId, orders, new uint8[](0));
        vm.stopPrank();
    }

    function _assertRouterClean(Market m) internal view {
        (address yes, address no) = m.tokens();
        uint40 id = router.accountId();
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(OutcomeToken(yes).balanceOf(address(router)), 0, "router YES");
        assertEq(OutcomeToken(no).balanceOf(address(router)), 0, "router NO");
        assertEq(core.getBalance(id, address(usdc)), 0, "Kuru account USDC");
        assertEq(core.getBalance(id, yes), 0, "Kuru account YES");
    }

    // ---------------------------------------------------------------- the path

    function test_fork_kuruV2_endToEnd() public {
        Market m = _market();
        address book = _graduateThroughKuru(m);
        uint40 makerId = _rest(m, book, 480_000, 520_000, 200e6);
        _tradeEveryPath(m);
        _assertRouterClean(m);
        _closeSettleRedeem(m, book, makerId);
    }

    /// Feeds from creation, Kuru's setup, registration at the predicted address, graduation, claims.
    function _graduateThroughKuru(Market m) internal returns (address book) {
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        feeds.createAdapter(address(m), Side.No);
        _fill(m);
        // The keeper pokes from creation, so the feed has history when Kuru sets the token up.
        _pokeAfter(m, 1);
        _pokeAfter(m, 31 minutes);
        (, int256 answer,,,) = OutcomeTokenPriceAdapter(yesFeed).latestRoundData();
        assertEq(answer, int256(uint256(300e6) * 1e6 / 550e6) * 100, "pool odds");

        vm.expectRevert(abi.encodeWithSignature("BookNotReady()"));
        m.graduate();

        address predicted = grad.predictedBook(address(m));
        book = _kuruSetup(m, yesFeed);
        assertEq(book, predicted, "Kuru deploys where GraduatorV2 predicts");
        assertEq(uint8(grad.bookProblem(address(m), book)), uint8(IGraduatorV2.Problem.None));
        grad.registerBook(address(m), book);
        m.graduate();
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        assertEq(m.book(), book);
        for (uint256 i; i < 11; ++i) {
            vm.prank(stakers[i]);
            m.claimTokens();
        }
    }

    /// buyYes, sellYes, buyNo and sellNo through Kuru's real AccountCore and WithdrawalLimiter.
    function _tradeEveryPath(Market m) internal {
        (address yes, address no) = m.tokens();
        _usdc(trader, 100e6);
        vm.startPrank(trader);
        OutcomeToken(yes).approve(address(router), type(uint256).max);
        OutcomeToken(no).approve(address(router), type(uint256).max);

        uint256 g = gasleft();
        uint256 yesOut = router.buyYes(address(m), 10e6, 0, block.timestamp);
        console2.log("buyYes gas", g - gasleft());
        assertApproxEqAbs(yesOut, uint256(10e6) * 1e6 / 520_000, 20_000, "about 19.2 YES after the fee");

        g = gasleft();
        assertGt(router.sellYes(address(m), yesOut, 0, block.timestamp), 9e6);
        console2.log("sellYes gas", g - gasleft());

        g = gasleft();
        uint256 paid = router.buyNo(address(m), 10e6, 6e6, block.timestamp);
        console2.log("buyNo gas", g - gasleft());
        assertApproxEqAbs(paid, 5.2e6, 20_000, "10 NO for about 5.2 USDC");
        assertEq(OutcomeToken(no).balanceOf(trader), 10e6);

        uint256 q = router.quoteSellNo(address(m), 5e6);
        g = gasleft();
        uint256 proceeds = router.sellNo(address(m), 5e6, 0, block.timestamp);
        console2.log("sellNo gas", g - gasleft());
        console2.log("sellNo quote", q);
        assertApproxEqAbs(proceeds, 5e6 - q, 10, "5 NO for 5 - Q");
        vm.stopPrank();
    }

    /// Kuru's soft pause at close: no swaps, but the maker can still cancel and withdraw. Settlement and
    /// redemption never touch Kuru.
    function _closeSettleRedeem(Market m, address book, uint40 makerId) internal {
        vm.warp(m.window().close);
        address[] memory books = new address[](1);
        books[0] = book;
        vm.prank(kuruOwner);
        spotRouter.toggleSpotMarkets(books, 1);

        vm.prank(trader);
        vm.expectRevert();
        router.buyYes(address(m), 1e6, 0, block.timestamp);

        vm.startPrank(maker);
        IKuruSpotOrderBookMaker(book).cancelAllOrders(makerId);
        core.withdraw(makerId, address(usdc), core.getBalance(makerId, address(usdc)), maker);
        vm.stopPrank();

        resolver.setAnswer(Outcome.No);
        m.settle("");
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        vault.redeem(address(m), Side.No, 5e6, trader);
        assertGt(usdc.balanceOf(trader), before);
        assertGe(vault.surplus(), 0, "solvent");
    }

    /// A stale YES price blocks withdrawals of YES (so a router buy reverts whole) until a poke refreshes it.
    function test_fork_kuruV2_stalePriceBlocksBuysUntilPoked() public {
        Market m = _market();
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        _fill(m);
        _pokeAfter(m, 1);
        _pokeAfter(m, 31 minutes);
        address book = _kuruSetup(m, yesFeed);
        grad.registerBook(address(m), book);
        m.graduate();
        _rest(m, book, 480_000, 520_000, 200e6);
        _usdc(trader, 100e6);

        vm.warp(block.timestamp + 2 hours);
        vm.roll(block.number + 1);
        vm.prank(trader);
        vm.expectRevert();
        router.buyYes(address(m), 10e6, 0, block.timestamp);

        oracle.poke(address(m));
        vm.prank(trader);
        assertGt(router.buyYes(address(m), 10e6, 0, block.timestamp), 0);
        _assertRouterClean(m);
    }

    /// The mainnet-first path on testnet: a stack deployed with WIRE_KURU=0 has no graduator; WireKuruV2
    /// adds GraduatorV2 and HunchRouterV2 later (the factory's one-time wiring, by the same deployer).
    function test_fork_kuruV2_wireLater() public {
        Deploy.Deployed memory p = new Deploy()
            .deployWith(
                DEPLOYER_KEY,
                deployer,
                deployer,
                Deploy.Options({kuruVersion: 2, stack: "forkWireV2", wireKuru: false, hunchVenue: false})
            );
        assertEq(HunchBookFactory(p.factory).graduator(), address(0));

        WireKuruV2 wireScript = new WireKuruV2();
        vm.expectRevert(bytes("only the factory's deployer can wire it"));
        wireScript.wire(0xBAD, p.factory, p.usdc);

        (address g, address r) = wireScript.wire(DEPLOYER_KEY, p.factory, p.usdc);
        assertEq(HunchBookFactory(p.factory).graduator(), g);
        assertEq(GraduatorV2(g).kuruVersion(), 2);
        assertEq(address(HunchRouterV2(r).factory()), p.factory);
        assertEq(address(GraduatorV2(g).spotRouter()), address(spotRouter));

        vm.expectRevert(bytes("this stack already has a graduator"));
        wireScript.wire(DEPLOYER_KEY, p.factory, p.usdc);
    }

    /// A real Kuru book with fees above GraduatorV2's limit is refused.
    function test_fork_kuruV2_refusesBooksOutsideLimits() public {
        Market m = _market();
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        _pokeAfter(m, 1);
        _pokeAfter(m, 31 minutes);
        _kuruSetup(m, yesFeed);
        IGraduatorV2.BookRequest memory r = grad.bookRequest(address(m));
        vm.prank(kuruOwner);
        address dear = spotRouter.deploySpotMarket(
            r.baseToken,
            r.quoteToken,
            r.sizePrecision,
            r.pricePrecision,
            r.tickSize,
            r.passiveSpreadTicks,
            r.minQuoteNotional,
            r.maxQuoteNotional,
            50_000,
            r.makerFeePps
        );
        assertEq(uint8(grad.bookProblem(address(m), dear)), uint8(IGraduatorV2.Problem.BadFees));
        vm.expectRevert(abi.encodeWithSelector(IGraduatorV2.BookMismatch.selector, IGraduatorV2.Problem.BadFees));
        grad.registerBook(address(m), dear);
    }
}
