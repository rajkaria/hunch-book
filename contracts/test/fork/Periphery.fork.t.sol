// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {DeployPeriphery} from "../../script/DeployPeriphery.s.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IHunchRouter} from "../../src/interfaces/IHunchRouter.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {Outcome, Phase, Side} from "../../src/interfaces/IHunchBookTypes.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {AutoRedeemer} from "../../src/periphery/AutoRedeemer.sol";
import {ConditionalOrders} from "../../src/periphery/ConditionalOrders.sol";
import {ImpliedProbabilityOracle} from "../../src/periphery/ImpliedProbabilityOracle.sol";
import {MerkleDistributor} from "../../src/periphery/MerkleDistributor.sol";
import {OutcomeTokenPriceAdapter} from "../../src/periphery/OutcomeTokenPriceAdapter.sol";
import {OutcomeTokenPriceAdapterFactory} from "../../src/periphery/OutcomeTokenPriceAdapterFactory.sol";
import {ReferralRegistry} from "../../src/periphery/ReferralRegistry.sol";
import {TemplateTimelock} from "../../src/periphery/TemplateTimelock.sol";
import {IConditionalOrders} from "../../src/periphery/interfaces/IConditionalOrders.sol";
import {IImpliedProbabilityOracle} from "../../src/periphery/interfaces/IImpliedProbabilityOracle.sol";

interface IERC20Fork {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// The periphery against Hunch Book's live testnet deployment and its market #1, whose YES/USDC Kuru
/// book is quoted by our labelled maker bot. Deploys the periphery with DeployPeriphery.s.sol on the
/// fork, then: the oracle reads the live book; conditional orders of all four kinds execute against
/// it through the live HunchRouter (owner funded from the test USDC faucet); a price adapter prices
/// the live market. Every expectation is derived from the book as it is at the fork block, so the
/// suite holds while the maker requotes. If market #1 is past close, the trading checks are skipped.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/Periphery.fork.t.sol
contract PeripheryForkTest is Test {
    address internal constant MARKET = 0x2A44B99014cF73065BFb89197a08DE09D18d3982;
    address internal constant BOOK = 0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a;
    uint256 internal constant DEPLOYER_KEY = 0xA11CE;
    uint256 internal constant ONE = 1e6;

    DeployPeriphery internal script;
    DeployPeriphery.Deployed internal d;
    IHunchBookFactory internal factory;
    address internal router;
    TestUSDC internal usdc;
    IMarket internal market = IMarket(MARKET);
    ImpliedProbabilityOracle internal oracle;
    ConditionalOrders internal orders;

    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        assertEq(block.chainid, 10_143);
        factory = IHunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        router = vm.parseJsonAddress(json, ".hunchBook.router");
        usdc = TestUSDC(vm.parseJsonAddress(json, ".hunchBook.usdc"));

        script = new DeployPeriphery();
        address deployer = vm.addr(DEPLOYER_KEY);
        vm.deal(deployer, 100 ether);
        d = script.deploy(DEPLOYER_KEY, script.config(json, deployer));
        oracle = ImpliedProbabilityOracle(d.impliedProbabilityOracle);
        orders = ConditionalOrders(d.conditionalOrders);
    }

    // ---------------------------------------------------------------- deployment

    function test_fork_deployScriptWiresEverything() public view {
        assertTrue(factory.isMarket(MARKET), "market #1 is a factory market");
        assertEq(market.book(), BOOK, "market #1's book");

        assertEq(AutoRedeemer(d.autoRedeemer).factory(), address(factory));
        assertEq(AutoRedeemer(d.autoRedeemer).vault(), factory.vault());
        assertEq(orders.factory(), address(factory));
        assertEq(orders.router(), router);
        assertEq(orders.usdc(), address(usdc));
        assertEq(ReferralRegistry(d.referralRegistry).DURATION(), 180 days);
        assertEq(MerkleDistributor(d.merkleDistributor).funder(), factory.feeRecipient());
        assertEq(oracle.factory(), address(factory));
        OutcomeTokenPriceAdapterFactory adapters = OutcomeTokenPriceAdapterFactory(d.priceAdapterFactory);
        assertEq(adapters.oracle(), address(oracle));
        assertEq(adapters.params().twapWindow, 30 minutes);
        TemplateTimelock lock = TemplateTimelock(d.templateTimelock);
        assertEq(lock.factory(), address(factory));
        assertEq(lock.proposer(), factory.guardian(), "testnet default proposer: the current guardian");
        assertEq(lock.delay(), 2 days);
        assertTrue(factory.guardian() != address(lock), "deployed, not made guardian");
    }

    // ---------------------------------------------------------------- oracle

    function test_fork_oracleReadsTheLiveBook() public {
        Phase p = market.phase();
        IImpliedProbabilityOracle.Quote memory q = oracle.quote(MARKET);
        assertEq(uint8(q.phase), uint8(p));
        if (p == Phase.Settled) {
            assertEq(q.chanceE6, market.outcome() == Outcome.Yes ? ONE : 0);
            return;
        }
        if (p == Phase.Voided) {
            assertEq(q.chanceE6, ONE / 2);
            return;
        }
        (uint256 bid18, uint256 ask18) = IKuruOrderBook(BOOK).bestBidAsk();
        bool hasBid = bid18 != type(uint256).max && bid18 != 0;
        bool hasAsk = ask18 != 0 && ask18 != type(uint256).max;
        console2.log("best bid (1e18)", bid18);
        console2.log("best ask (1e18)", ask18);
        assertEq(q.hasBid, hasBid);
        assertEq(q.hasAsk, hasAsk);
        uint256 bid = hasBid ? _min(bid18 / 1e12, ONE) : 0;
        uint256 ask = hasAsk ? _min((ask18 + 1e12 - 1) / 1e12, ONE) : 0;
        if (hasBid && hasAsk) {
            assertEq(q.chanceE6, (bid + ask) / 2, "mid");
            assertEq(q.spreadE6, ask > bid ? ask - bid : 0);
        } else if (hasBid || hasAsk) {
            assertEq(q.chanceE6, hasBid ? bid : ask);
        } else {
            assertTrue(q.stale);
        }

        // Poke twice across 30 minutes of an unchanged book: the average is the spot.
        assertTrue(oracle.poke(MARKET));
        vm.warp(block.timestamp + 30 minutes);
        vm.roll(block.number + 1);
        assertTrue(oracle.poke(MARKET));
        assertEq(oracle.consult(MARKET, 30 minutes), q.chanceE6);

        // A conservative adapter price on the live market, below 1 - fee.
        OutcomeTokenPriceAdapterFactory adapters = OutcomeTokenPriceAdapterFactory(d.priceAdapterFactory);
        OutcomeTokenPriceAdapter yesFeed = OutcomeTokenPriceAdapter(adapters.createAdapter(MARKET, Side.Yes));
        (, int256 answer,, uint256 updatedAt,) = yesFeed.latestRoundData();
        console2.log("YES adapter answer (8 decimals)", uint256(answer));
        assertEq(updatedAt, block.timestamp);
        assertLe(uint256(answer), (ONE - market.feePerToken(Side.Yes)) * 100);
        assertLe(uint256(answer), q.chanceE6 * 100);
    }

    // ---------------------------------------------------------------- conditional orders

    IERC20Fork internal yesToken;
    IERC20Fork internal noToken;

    function test_fork_conditionalOrdersAgainstTheLiveBook() public {
        if (market.phase() != Phase.Graduated) {
            console2.log("market #1 is not trading any more: trading checks skipped");
            return;
        }
        (bool hasAsk,,) = _bestAsk();
        (bool hasBid,,) = _bestBid();
        if (!hasAsk || !hasBid) {
            console2.log("market #1's book is one-sided: trading checks skipped");
            return;
        }
        (address yesAddr, address noAddr) = market.tokens();
        yesToken = IERC20Fork(yesAddr);
        noToken = IERC20Fork(noAddr);
        usdc.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdc.approve(address(orders), type(uint256).max);
        yesToken.approve(address(orders), type(uint256).max);
        noToken.approve(address(orders), type(uint256).max);
        vm.stopPrank();

        uint256 yesGot = _limitBuyYesAtTheAsk();
        _stopLossAtTheBid(yesGot);
        uint256 noGot = _buyNoAtItsAsk();
        _takeProfitOnNo(noGot);
    }

    /// 1. A limit buy at the best ask for a quarter of its size.
    function _limitBuyYesAtTheAsk() internal returns (uint256 got) {
        (, uint256 ask, uint256 askSize) = _bestAsk();
        uint256 wanted = askSize / 4;
        uint256 minOut = wanted * 99 / 100;
        uint256 id =
            _place(IHunchRouter.Kind.BuyYes, IConditionalOrders.Condition.AtOrBelow, ask, wanted * ask / ONE, minOut);
        vm.prank(keeper);
        got = orders.execute(id);
        assertGe(got, minOut);
        assertEq(yesToken.balanceOf(alice), got);
        _assertClean();
    }

    /// 2. A stop-loss at the best bid sells what was bought (at most a quarter of the bid).
    function _stopLossAtTheBid(uint256 yesGot) internal {
        (, uint256 bid, uint256 bidSize) = _bestBid();
        uint256 sell = _min(yesGot, bidSize / 4);
        uint256 minOut = sell * bid / ONE * 99 / 100;
        uint256 id = _place(IHunchRouter.Kind.SellYes, IConditionalOrders.Condition.AtOrBelow, bid, sell, minOut);
        uint256 before = usdc.balanceOf(alice);
        orders.execute(id);
        assertGe(usdc.balanceOf(alice) - before, minOut);
        _assertClean();
    }

    /// 3. Buy NO when its ask (1 - YES bid) is at or below the trigger.
    function _buyNoAtItsAsk() internal returns (uint256 got) {
        (, uint256 bid, uint256 bidSize) = _bestBid();
        uint256 wanted = bidSize / 4;
        uint256 id = _place(IHunchRouter.Kind.BuyNo, IConditionalOrders.Condition.AtOrBelow, ONE - bid, wanted, wanted);
        got = orders.execute(id);
        assertEq(got, wanted - wanted * 10 / 10_000, "exactly the NO asked for, minus the tip");
        assertEq(noToken.balanceOf(alice), got);
        _assertClean();
    }

    /// 4. Take profit on that NO once its bid (1 - YES ask) is at or above the trigger.
    function _takeProfitOnNo(uint256 noGot) internal {
        (, uint256 ask, uint256 askSize) = _bestAsk();
        uint256 sell = _min(noGot, askSize / 4);
        uint256 id = _place(IHunchRouter.Kind.SellNo, IConditionalOrders.Condition.AtOrAbove, ONE - ask, sell, 0);
        uint256 before = usdc.balanceOf(alice);
        orders.execute(id);
        assertGt(usdc.balanceOf(alice), before);
        assertEq(noToken.balanceOf(alice), noGot - sell);
        _assertClean();
    }

    // ---------------------------------------------------------------- helpers

    function _place(
        IHunchRouter.Kind kind,
        IConditionalOrders.Condition c,
        uint256 trigger,
        uint256 amountIn,
        uint256 limit
    ) internal returns (uint256 id) {
        vm.prank(alice);
        id = orders.place(
            IConditionalOrders.OrderRequest({
                market: MARKET,
                kind: kind,
                condition: c,
                triggerPriceE6: uint32(trigger),
                expiry: uint64(block.timestamp + 1 hours),
                executorTipBps: 10,
                amountIn: uint128(amountIn),
                limit: uint128(limit)
            })
        );
        assertTrue(orders.isTriggered(id), "triggered at the live price");
    }

    /// Best resting ask level: price (E6) and size, from the L2 book.
    function _bestAsk() internal view returns (bool, uint256, uint256) {
        bytes memory l2 = IKuruOrderBook(BOOK).getL2Book(0, 1);
        // [block] [0] [ask price, size]
        if (l2.length < 4 * 32) return (false, 0, 0);
        return (true, _word(l2, 2), _word(l2, 3));
    }

    /// Best resting bid level: price (E6) and size.
    function _bestBid() internal view returns (bool, uint256, uint256) {
        bytes memory l2 = IKuruOrderBook(BOOK).getL2Book(1, 0);
        // [block] [bid price, size] [0]
        if (l2.length < 3 * 32 || _word(l2, 1) == 0) return (false, 0, 0);
        return (true, _word(l2, 1), _word(l2, 2));
    }

    function _word(bytes memory data, uint256 i) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), mul(i, 32)))
        }
    }

    function _assertClean() internal view {
        assertEq(usdc.balanceOf(address(orders)), 0, "orders USDC");
        assertEq(yesToken.balanceOf(address(orders)), 0, "orders YES");
        assertEq(noToken.balanceOf(address(orders)), 0, "orders NO");
        assertEq(usdc.balanceOf(router), 0, "router USDC");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
