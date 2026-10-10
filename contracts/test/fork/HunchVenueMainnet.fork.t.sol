// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {HunchMarginAccount} from "../../src/venue/HunchMarginAccount.sol";
import {HunchOrderBook} from "../../src/venue/HunchOrderBook.sol";
import {HunchOrderBookFactory} from "../../src/venue/HunchOrderBookFactory.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// Mainnet launch with Hunch's own order book, on a fork of Monad mainnet with Circle USDC and the real
/// deploy script (VENUE=hunch): a market fills its pool, graduates into a book created in the same
/// transaction (no Kuru action anywhere), a maker quotes, traders trade YES and NO through the router,
/// the book stops at close, the market settles and winners redeem.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/HunchVenueMainnet.fork.t.sol
contract HunchVenueMainnetForkTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xB0B;

    Deploy.Deployed internal d;
    IERC20Like internal usdc;
    HunchBookFactory internal factory;
    CollateralVault internal vault;
    HunchRouter internal router;
    HunchOrderBookFactory internal venue;
    HunchMarginAccount internal margin;
    MockResolver internal resolver;

    address internal guardian = makeAddr("guardian multisig");
    address internal feeRecipient = makeAddr("fee recipient");
    address internal maker = makeAddr("maker");
    address internal trader = makeAddr("trader");
    address[] internal stakers;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, 143);
        vm.deal(vm.addr(DEPLOYER_KEY), 1000 ether);
        Deploy script = new Deploy();
        d = script.deployWith(
            DEPLOYER_KEY,
            guardian,
            feeRecipient,
            Deploy.Options({kuruVersion: 1, stack: "", wireKuru: true, hunchVenue: true})
        );
        usdc = IERC20Like(d.usdc);
        factory = HunchBookFactory(d.factory);
        vault = CollateralVault(d.vault);
        router = HunchRouter(d.router);
        venue = HunchOrderBookFactory(d.bookFactory);
        margin = HunchMarginAccount(d.marginAccount);

        resolver = new MockResolver();
        vm.prank(guardian);
        factory.addTemplate(
            90,
            IResolver(address(resolver)),
            GraduationRule({minPool: 100e6, minStakers: 3, minChanceBps: 300, maxChanceBps: 9700})
        );
        for (uint256 i; i < 4; ++i) {
            stakers.push(makeAddr(string.concat("staker", vm.toString(i))));
            _fund(stakers[i], 100e6);
        }
        _fund(maker, 2000e6);
        _fund(trader, 500e6);
    }

    function test_deployWiresHunchVenueOnMainnet() public view {
        assertEq(d.usdc, 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, "Circle USDC");
        assertEq(factory.graduator(), d.graduator);
        Graduator g = Graduator(d.graduator);
        assertTrue(g.canCreateBooks(), "books are created at graduation");
        assertEq(address(g.kuruRouter()), d.bookFactory);
        assertEq(address(g.kuruMarginAccount()), d.marginAccount);
        assertEq(address(venue.marginAccount()), d.marginAccount);
        assertEq(venue.implementation(), d.bookImplementation);
        assertEq(address(venue.hunchFactory()), d.factory);
        assertEq(venue.usdc(), d.usdc);
        assertEq(d.kuruVersion, 1);
    }

    function test_marketGraduatesTradesSettlesWithNoThirdParty() public {
        Window memory w = Window({
            blockClock: false,
            lock: uint64(block.timestamp + 1 days),
            close: uint64(block.timestamp + 2 days),
            settleDeadline: uint64(block.timestamp + 9 days)
        });
        vm.prank(stakers[0]);
        Market m = Market(payable(factory.createMarket(90, abi.encode(w), Side.Yes, 40e6)));
        vm.prank(stakers[1]);
        m.stake(Side.Yes, 30e6);
        vm.prank(stakers[2]);
        m.stake(Side.No, 50e6);
        vm.prank(stakers[3]);
        m.stake(Side.No, 20e6);

        m.graduate();
        HunchOrderBook book = HunchOrderBook(m.book());
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        assertEq(book.market(), address(m));
        assertTrue(margin.verifiedMarket(address(book)));
        m.claimTokensFor(stakers);

        (address yesAddr, address noAddr) = m.tokens();
        OutcomeToken yes = OutcomeToken(yesAddr);
        OutcomeToken no = OutcomeToken(noAddr);

        // The maker: 500 sets and 300 USDC on the venue, quotes 0.44 / 0.47.
        vm.startPrank(maker);
        vault.mintSets(address(m), 500e6, maker);
        yes.approve(address(margin), type(uint256).max);
        margin.deposit(maker, yesAddr, 500e6);
        margin.deposit(maker, address(usdc), 300e6);
        book.addBuyOrder(440_000, 200e6, true);
        book.addSellOrder(470_000, 200e6, true);
        vm.stopPrank();

        vm.startPrank(trader);
        uint256 yesOut = router.buyYes(address(m), 47e6, 100e6, block.timestamp);
        assertEq(yesOut, 100e6);
        no.approve(address(router), type(uint256).max);
        uint256 noPaid = router.buyNo(address(m), 50e6, 30e6, block.timestamp);
        assertEq(noPaid, 50e6 - 22e6); // 50 YES sold at 0.44
        assertEq(no.balanceOf(trader), 50e6);
        vm.stopPrank();

        // Close: the book refuses to match, cancels still work.
        vm.warp(w.close);
        assertEq(book.marketState(), 1);
        uint40[] memory ids = new uint40[](2);
        (ids[0], ids[1]) = (1, 2);
        vm.prank(maker);
        book.batchUpdate(new uint32[](0), new uint96[](0), new uint32[](0), new uint96[](0), ids, true);

        resolver.setAnswer(Outcome.Yes);
        m.settle("");
        vm.prank(trader);
        uint256 paid = vault.redeem(address(m), Side.Yes, yesOut, trader);
        assertEq(paid, 99e6); // 2% of the losing side over the pool: 1 cent per winning token
        assertGe(usdc.balanceOf(address(vault)), vault.totalObligations(), "vault insolvent");
        assertEq(usdc.balanceOf(address(margin)), margin.tracked(address(usdc)), "margin account drift");
    }

    function _fund(address who, uint256 amount) internal {
        deal(d.usdc, who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), type(uint256).max);
        usdc.approve(address(margin), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }
}
