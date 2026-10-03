// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {IKuruMarginAccount} from "../../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {IKuruRouter} from "../../src/interfaces/external/IKuruRouter.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

/// The whole lifecycle on a fork of Monad testnet, with every Hunch Book contract real and Kuru's
/// real Router, MarginAccount and order book: create, stake, graduate into a new Kuru book, claim,
/// a maker quoting both sides, all four router trades, close, settle, redeem. After every step the
/// vault is solvent, YES supply = NO supply = sets, and the router holds nothing.
/// (The resolver is a stand-in here: real resolvers are fork-tested against real Perpl and
/// Chainlink data in their own suites, and a fork cannot produce future funding events.)
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/EndToEnd.fork.t.sol
contract EndToEndForkTest is Test {
    TestUSDC internal usdc;
    HunchBookFactory internal factory;
    CollateralVault internal vault;
    Graduator internal graduator;
    HunchRouter internal router;
    MockResolver internal resolver;
    IKuruMarginAccount internal margin;

    address internal creator = makeAddr("creator");
    address internal maker = makeAddr("maker");
    address internal feeRecipient = makeAddr("feeRecipient");
    address[] internal stakers;

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        margin = IKuruMarginAccount(vm.parseJsonAddress(json, ".external.kuru.marginAccount"));

        usdc = new TestUSDC();
        resolver = new MockResolver();
        factory = new HunchBookFactory(
            address(usdc),
            address(new Market()),
            address(this),
            feeRecipient,
            MarketCaps({poolCap: 5000e6, walletCap: 1000e6, minStake: 1e6, creatorMinStake: 5e6}),
            50_000e6
        );
        vault = CollateralVault(factory.vault());
        factory.addTemplate(
            1,
            IResolver(address(resolver)),
            GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700})
        );
        graduator = new Graduator(
            IHunchBookFactory(address(factory)),
            IKuruRouter(vm.parseJsonAddress(json, ".external.kuru.router")),
            margin,
            address(usdc),
            true,
            IGraduator.BookParams({
                sizePrecision: 1e6,
                pricePrecision: 1e6,
                tickSize: 1000,
                minSize: 1e6,
                takerFeeBps: 0,
                makerFeeBps: 0,
                kuruAmmSpread: 30
            })
        );
        factory.setGraduator(address(graduator));
        router = new HunchRouter(IHunchBookFactory(address(factory)));

        _fund(creator);
        _fund(maker);
        for (uint256 i; i < 10; ++i) {
            address u = makeAddr(string.concat("staker", vm.toString(i)));
            stakers.push(u);
            _fund(u);
        }
    }

    // State shared by the lifecycle steps (split to keep each function's stack small).
    Market internal m;
    IKuruOrderBook internal book;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    Window internal w;
    uint256 internal y;
    uint256 internal n;
    address[] internal all;
    address internal trader = makeAddr("trader");
    uint256 internal traderYes;

    function test_fullLifecycleOnRealKuru() public {
        _createStakeGraduate();
        _makerQuotes();
        _tradeYes();
        _tradeNo();
        _closeSettleRedeem();
    }

    function _createStakeGraduate() internal {
        w = Window({
            blockClock: false,
            lock: uint64(block.timestamp + 1 days),
            close: uint64(block.timestamp + 2 days),
            settleDeadline: uint64(block.timestamp + 9 days)
        });
        vm.prank(creator);
        m = Market(payable(factory.createMarket(1, abi.encode(w), Side.Yes, 5e6)));
        for (uint256 i; i < 10; ++i) {
            vm.prank(stakers[i]);
            m.stake(i < 6 ? Side.Yes : Side.No, i < 6 ? 50e6 : 60e6);
        }
        (y, n,) = m.poolTotals();
        assertEq(y, 305e6);
        assertEq(n, 240e6);
        _check();

        // A real Kuru book is created inside graduate() and verified by the Graduator.
        m.graduate();
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        book = IKuruOrderBook(m.book());
        assertEq(address(book), graduator.bookOf(address(m)));
        assertTrue(margin.verifiedMarket(address(book)));
        _check();

        all.push(creator);
        for (uint256 i; i < 10; ++i) {
            all.push(stakers[i]);
        }
        m.claimTokensFor(all);
        (address yesAddr, address noAddr) = m.tokens();
        yes = OutcomeToken(yesAddr);
        no = OutcomeToken(noAddr);
        assertEq(yes.balanceOf(address(m)), 0);
        _check();
    }

    /// A maker quotes both sides from minted sets: asks 0.58 and 0.60, bids 0.52 and 0.50.
    function _makerQuotes() internal {
        vm.startPrank(maker);
        vault.mintSets(address(m), 300e6, maker);
        yes.approve(address(margin), 300e6);
        margin.deposit(maker, address(yes), 300e6);
        book.addSellOrder(580_000, 150e6, true);
        book.addSellOrder(600_000, 150e6, true);
        usdc.approve(address(margin), 200e6);
        margin.deposit(maker, address(usdc), 200e6);
        book.addBuyOrder(520_000, 150e6, true);
        book.addBuyOrder(500_000, 150e6, true);
        vm.stopPrank();
        _check();
    }

    function _tradeYes() internal {
        _fund(trader);
        vm.startPrank(trader);
        usdc.approve(address(router), type(uint256).max);
        traderYes = router.buyYes(address(m), 29e6, 49e6, block.timestamp);
        vm.stopPrank();
        assertEq(traderYes, 50e6, "29 USDC at 0.58 buys 50 YES");
        _check();

        // A staker exits before the answer.
        address seller = stakers[0];
        uint256 sellerYes = yes.balanceOf(seller);
        vm.startPrank(seller);
        yes.approve(address(router), sellerYes);
        uint256 usdcOut = router.sellYes(address(m), 40e6, 20e6, block.timestamp);
        vm.stopPrank();
        assertEq(usdcOut, 20_800_000, "40 YES at 0.52");
        assertEq(yes.balanceOf(seller), sellerYes - 40e6);
        _check();
    }

    function _tradeNo() internal {
        address noBuyer = makeAddr("noBuyer");
        _fund(noBuyer);
        vm.startPrank(noBuyer);
        usdc.approve(address(router), type(uint256).max);
        uint256 before = usdc.balanceOf(noBuyer);
        uint256 paid = router.buyNo(address(m), 100e6, 50e6, block.timestamp);
        vm.stopPrank();
        // The 100 minted YES sell into the 110 still bid at 0.52: proceeds 52, so the buyer pays 48.
        assertEq(no.balanceOf(noBuyer), 100e6, "exactly 100 NO");
        assertEq(before - usdc.balanceOf(noBuyer), paid);
        assertEq(paid, 48e6);
        _check();

        address noSeller = stakers[6];
        uint256 noBal = no.balanceOf(noSeller);
        vm.startPrank(noSeller);
        no.approve(address(router), noBal);
        uint256 quote = router.quoteSellNo(address(m), 60e6);
        uint256 got = router.sellNo(address(m), 60e6, 1, block.timestamp);
        vm.stopPrank();
        assertEq(quote, 34_800_000, "60 YES at 0.58 (100 left at that level)");
        assertEq(got, 60e6 - quote);
        assertEq(no.balanceOf(noSeller), noBal - 60e6);
        _check();
    }

    function _closeSettleRedeem() internal {
        vm.warp(w.close);
        assertEq(uint8(m.phase()), uint8(Phase.Closed));
        vm.prank(trader);
        vm.expectRevert(IHunchRouter.NotTradable.selector);
        router.buyYes(address(m), 1e6, 0, block.timestamp);

        resolver.setAnswer(Outcome.Yes);
        m.settle("");
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        assertGt(m.feePerToken(Side.Yes), 0);

        vm.prank(trader);
        uint256 redeemed = vault.redeem(address(m), Side.Yes, traderYes, trader);
        uint256 fee = (traderYes * 200 * n + 10_000 * (y + n) - 1) / (10_000 * (y + n));
        assertEq(redeemed, traderYes - fee);

        // Every remaining YES holder redeems; the vault can pay all of it.
        for (uint256 i; i < all.length; ++i) {
            uint256 b = yes.balanceOf(all[i]);
            if (b == 0) continue;
            vm.prank(all[i]);
            vault.redeem(address(m), Side.Yes, b, all[i]);
        }
        vm.prank(stakers[7]);
        vm.expectRevert();
        vault.redeem(address(m), Side.No, 1e6, stakers[7]);
        _check();
        assertGt(vault.protocolFees(), 0);
        assertGt(vault.creatorFees(creator), 0);
    }

    function _fund(address who) internal {
        usdc.mint(who, 2000e6);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _check() internal view {
        assertGe(vault.surplus(), 0, "solvent");
        (address yesAddr, address noAddr) = m.tokens();
        uint256 sets = vault.ledger(address(m)).sets;
        if (m.phase() != Phase.Settled) {
            assertEq(OutcomeToken(yesAddr).totalSupply(), sets, "YES = sets");
            assertEq(OutcomeToken(noAddr).totalSupply(), sets, "NO = sets");
        }
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
        assertEq(OutcomeToken(yesAddr).balanceOf(address(router)), 0, "router holds no YES");
        assertEq(OutcomeToken(noAddr).balanceOf(address(router)), 0, "router holds no NO");
    }
}
