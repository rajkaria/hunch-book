// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {GuardianBatch} from "../../script/GuardianBatch.s.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {GraduationRule, MarketCaps, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {MockResolver} from "../mocks/MockResolver.sol";
import {PriceAtTimeParams} from "../../src/interfaces/ITemplates.sol";
import {IChainlinkAggregator} from "../../src/interfaces/external/IChainlinkAggregator.sol";
import {IKuruMarginAccount} from "../../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {IKuruRouter} from "../../src/interfaces/external/IKuruRouter.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IChainlinkLatest {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IOwned {
    function owner() external view returns (address);
}

/// A dress rehearsal of the mainnet launch on a fork of Monad mainnet, using the real deploy script,
/// Circle USDC, Kuru's mainnet Router, MarginAccount and order book, and Chainlink's BTC/USD feed:
///
///   1. Deploy.s.sol deploys everything with a separate guardian (it refuses the deployer as guardian).
///   2. The guardian registers the templates from the batch GuardianBatch.s.sol writes.
///   3. A BTC price market fills its pool. graduate() fails because Kuru's mainnet market creation is
///      owner-only, so (as Kuru would) the Kuru owner creates the YES/USDC book with our parameters,
///      and an outsider registers it. graduate() then succeeds.
///   4. A maker quotes, a trader buys YES through the router, the market closes and settles from the
///      Chainlink round that brackets the close time, and the winner redeems.
///
/// The only stand-in: a fork cannot see future Chainlink rounds, so the two rounds around the close
/// time are mocked on the real feed. The real resolver checks them exactly as it would live.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/MainnetRehearsal.fork.t.sol
contract MainnetRehearsalForkTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xA11CE;

    Deploy internal script;
    Deploy.Deployed internal d;
    string internal json;

    address internal deployer;
    address internal guardian = makeAddr("guardian multisig");
    address internal feeRecipient = makeAddr("fee recipient");
    address internal outsider = makeAddr("outsider");
    address internal maker = makeAddr("maker");
    address internal trader = makeAddr("trader");

    IERC20Like internal usdc;
    HunchBookFactory internal factory;
    CollateralVault internal vault;
    Graduator internal graduator;
    HunchRouter internal router;
    IChainlinkAggregator internal btc;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, 143);

        deployer = vm.addr(DEPLOYER_KEY);
        vm.deal(deployer, 1000 ether);
        script = new Deploy();
        // The v1 rehearsal (Kuru v1 is live on mainnet; the fallback if Kuru v2 slips). The v2 launch path
        // is rehearsed in test_mainnetFirst* below and on testnet in KuruV2.fork.t.sol.
        d = script.deployWith(
            DEPLOYER_KEY, guardian, feeRecipient, Deploy.Options({kuruVersion: 1, stack: "", wireKuru: true})
        );

        usdc = IERC20Like(d.usdc);
        factory = HunchBookFactory(d.factory);
        vault = CollateralVault(d.vault);
        graduator = Graduator(d.graduator);
        router = HunchRouter(d.router);
        btc = IChainlinkAggregator(vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']"));
    }

    // ------------------------------------------------------------------ deploy

    function test_deployUsesMainnetCollateralAndBetaLimits() public view {
        assertEq(d.usdc, vm.parseJsonAddress(json, ".external.usdc"), "Circle USDC");
        assertEq(vault.usdc(), d.usdc);
        assertEq(factory.vault(), d.vault);
        assertEq(factory.guardian(), guardian);
        assertEq(factory.feeRecipient(), feeRecipient);
        assertEq(factory.graduator(), d.graduator);

        // PROTOCOL.md §10.3 beta limits.
        MarketCaps memory c = factory.caps();
        assertEq(c.poolCap, 5000e6);
        assertEq(c.walletCap, 1000e6);
        assertEq(c.minStake, 1e6);
        assertEq(c.creatorMinStake, 5e6);
        assertEq(vault.collateralCap(), 50_000e6);

        // Kuru's mainnet book creation is owner-only: the Graduator only verifies and registers.
        assertFalse(graduator.canCreateBooks());
        // The deployer is not the guardian, so no template is registered until the multisig does it.
        assertEq(address(factory.templateOf(1).resolver), address(0));
        assertEq(address(factory.templateOf(2).resolver), address(0));
        assertFalse(factory.creationPaused());
        assertFalse(factory.graduationPaused());
    }

    function test_deployRefusesTheDeployerAsMainnetGuardian() public {
        Deploy again = new Deploy();
        vm.expectRevert(bytes("mainnet guardian must be a separate multisig, not the deployer"));
        again.deploy(DEPLOYER_KEY, deployer, feeRecipient);
    }

    // ------------------------------------------------------------------ mainnet first, Kuru v2 later

    /// Kuru v2 is the mainnet default, and its addresses are not in the deployments file yet: a full
    /// deploy stops with instructions instead of deploying a graduator that points nowhere.
    function test_mainnetFirst_v2NeedsKuruAddressesOrWireLater() public {
        Deploy again = new Deploy();
        assertEq(again.options().kuruVersion, 2, "v2 is the mainnet default");
        vm.expectRevert(
            bytes(
                "Kuru v2 addresses are not in the deployments file: deploy with WIRE_KURU=0, wire later (WireKuruV2.s.sol)"
            )
        );
        again.deployWith(
            DEPLOYER_KEY, guardian, feeRecipient, Deploy.Options({kuruVersion: 2, stack: "", wireKuru: true})
        );
    }

    /// WIRE_KURU=0: pools run with no graduator. A pool that meets its rule cannot graduate (no book can
    /// exist yet), locks, and settles as a pool; nobody's money waits on Kuru.
    function test_mainnetFirst_poolsRunWithoutAGraduator() public {
        Deploy again = new Deploy();
        Deploy.Deployed memory p = again.deployWith(
            DEPLOYER_KEY, guardian, feeRecipient, Deploy.Options({kuruVersion: 2, stack: "", wireKuru: false})
        );
        HunchBookFactory f = HunchBookFactory(p.factory);
        assertEq(p.graduator, address(0));
        assertEq(p.router, address(0));
        assertEq(f.graduator(), address(0));
        assertEq(p.kuruVersion, 2);

        MockResolver mock = new MockResolver();
        vm.prank(guardian);
        f.addTemplate(
            99,
            IResolver(address(mock)),
            GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700})
        );
        Window memory w;
        w.lock = uint64(block.timestamp + 1 days);
        w.close = uint64(block.timestamp + 2 days);
        w.settleDeadline = w.close + 7 days;
        address creator = makeAddr("creator");
        deal(p.usdc, creator, 50e6);
        vm.startPrank(creator);
        IERC20Like(p.usdc).approve(p.vault, type(uint256).max);
        Market m = Market(payable(f.createMarket(99, abi.encode(w), Side.Yes, 50e6)));
        vm.stopPrank();
        for (uint256 i; i < 10; ++i) {
            address u = makeAddr(string.concat("staker", vm.toString(i)));
            deal(p.usdc, u, 60e6);
            vm.startPrank(u);
            IERC20Like(p.usdc).approve(p.vault, type(uint256).max);
            m.stake(i < 5 ? Side.Yes : Side.No, 60e6);
            vm.stopPrank();
        }
        assertTrue(m.graduationRuleMet());
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();

        vm.warp(w.close);
        assertEq(uint8(m.phase()), uint8(Phase.PoolLocked));
        mock.setAnswer(Outcome.Yes);
        m.settle("");
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        address winner = makeAddr("staker0");
        uint256 before = IERC20Like(p.usdc).balanceOf(winner);
        vm.prank(winner);
        m.claimPool();
        assertGt(IERC20Like(p.usdc).balanceOf(winner), before);
    }

    function test_guardianBatchRegistersTemplatesAndNobodyElseCan() public {
        GuardianBatch batch = new GuardianBatch();
        bytes memory call1 = batch.calldataFor(1, d.perplFunding);

        vm.prank(outsider);
        (bool ok,) = address(factory).call(call1);
        assertFalse(ok, "only the guardian adds templates");

        _registerTemplates();
        assertEq(address(factory.templateOf(1).resolver), d.perplFunding);
        assertEq(address(factory.templateOf(2).resolver), d.priceAtTime);
        assertEq(factory.templateOf(2).rule.minPool, 500e6);
        assertEq(factory.templateOf(2).rule.minStakers, 10);
    }

    // ------------------------------------------------------------------ lifecycle

    Market internal m;
    OutcomeToken internal yes;
    PriceAtTimeParams internal p;
    address[] internal stakers;
    uint80 internal lastRound;

    function test_fullMainnetLifecycleWithKuruCreatedBook() public {
        _registerTemplates();
        _createAndFillPool();
        address book = _kuruCreatesBookAndOutsiderRegistersIt();
        _graduateAndQuote(book);
        _tradeCloseSettleRedeem(book);
    }

    function _createAndFillPool() internal {
        (uint80 latest, int256 answer,, uint256 updatedAt,) = IChainlinkLatest(address(btc)).latestRoundData();
        lastRound = latest;
        assertGt(updatedAt, 0, "live BTC/USD feed");
        uint8 dec = btc.decimals();
        // Strike at the current price (8 decimals); the mocked close round sits above it, so YES wins.
        int256 strikeE8 = dec >= 8 ? answer / int256(10 ** (dec - 8)) : answer * int256(10 ** (8 - dec));
        p = PriceAtTimeParams({
            source: 0,
            feed: address(btc),
            pythId: bytes32(0),
            strikeE8: strikeE8,
            lockTime: uint64(block.timestamp + 1 hours),
            closeTime: uint64(block.timestamp + 2 hours)
        });

        address creator = makeAddr("creator");
        _fund(creator, 100e6);
        vm.prank(creator);
        m = Market(payable(factory.createMarket(2, abi.encode(p), Side.Yes, 5e6)));

        for (uint256 i; i < 10; ++i) {
            address u = makeAddr(string.concat("staker", vm.toString(i)));
            stakers.push(u);
            _fund(u, 200e6);
            vm.prank(u);
            m.stake(i < 6 ? Side.Yes : Side.No, i < 6 ? 50e6 : 60e6);
        }
        stakers.push(creator);
        assertTrue(m.graduationRuleMet());
        _checkSolvent();
    }

    function _kuruCreatesBookAndOutsiderRegistersIt() internal returns (address book) {
        // No book yet and the Graduator cannot create one on mainnet.
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();

        IKuruRouter kuru = IKuruRouter(vm.parseJsonAddress(json, ".external.kuru.router"));
        IGraduator.BookParams memory bp = graduator.bookParams();
        (address yesAddr,) = m.tokens();

        // Anyone but Kuru's owner is refused.
        vm.prank(outsider);
        vm.expectRevert();
        kuru.deployProxy(
            0, yesAddr, d.usdc, bp.sizePrecision, bp.pricePrecision, bp.tickSize, bp.minSize, 5000e6, 0, 0, 30
        );

        address kuruOwner = IOwned(address(kuru)).owner();
        uint96 maxSize = uint96(m.caps().poolCap);
        vm.prank(kuruOwner);
        book = kuru.deployProxy(
            0,
            yesAddr,
            d.usdc,
            bp.sizePrecision,
            bp.pricePrecision,
            bp.tickSize,
            bp.minSize,
            maxSize,
            bp.takerFeeBps,
            bp.makerFeeBps,
            bp.kuruAmmSpread
        );
        IKuruMarginAccount margin = IKuruMarginAccount(vm.parseJsonAddress(json, ".external.kuru.marginAccount"));
        assertTrue(margin.verifiedMarket(book));

        vm.prank(outsider);
        graduator.registerBook(address(m), book);
        assertEq(graduator.bookOf(address(m)), book);
    }

    function _graduateAndQuote(address book) internal {
        vm.prank(outsider);
        m.graduate();
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        assertEq(m.book(), book);
        m.claimTokensFor(stakers);
        (address yesAddr,) = m.tokens();
        yes = OutcomeToken(yesAddr);
        _checkSolvent();

        // A maker quotes YES at 0.54 bid / 0.58 ask from minted sets.
        IKuruMarginAccount margin = IKuruMarginAccount(vm.parseJsonAddress(json, ".external.kuru.marginAccount"));
        _fund(maker, 1000e6);
        vm.startPrank(maker);
        usdc.approve(address(vault), type(uint256).max);
        vault.mintSets(address(m), 200e6, maker);
        yes.approve(address(margin), 200e6);
        margin.deposit(maker, yesAddr, 200e6);
        IKuruOrderBook(book).addSellOrder(580_000, 200e6, true);
        usdc.approve(address(margin), 200e6);
        margin.deposit(maker, d.usdc, 200e6);
        IKuruOrderBook(book).addBuyOrder(540_000, 200e6, true);
        vm.stopPrank();
        _checkSolvent();
    }

    function _tradeCloseSettleRedeem(address) internal {
        _fund(trader, 100e6);
        vm.startPrank(trader);
        usdc.approve(address(router), type(uint256).max);
        uint256 bought = router.buyYes(address(m), 29e6, 49e6, block.timestamp);
        vm.stopPrank();
        assertEq(bought, 50e6, "29 USDC at 0.58 buys 50 YES on the real Kuru book");
        _checkSolvent();

        // Past close: the router refuses, settlement reads the round that brackets the close time.
        vm.warp(p.closeTime + 10 minutes);
        assertEq(uint8(m.phase()), uint8(Phase.Closed));
        uint80 r = _mockRoundsAroundClose();
        m.settle(abi.encode(r));
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));

        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        uint256 paid = vault.redeem(address(m), Side.Yes, bought, trader);
        assertEq(usdc.balanceOf(trader) - before, paid);
        assertGt(paid, bought * 98 / 100, "fee is at most 2 cents a token");
        _checkSolvent();
    }

    /// Future rounds a fork cannot see: one 30 seconds before the close time above the strike,
    /// and the next one 30 seconds after it.
    function _mockRoundsAroundClose() internal returns (uint80 r) {
        r = lastRound + 1;
        int256 above = _toFeed(p.strikeE8 + 1000e8);
        vm.mockCall(
            address(btc),
            abi.encodeCall(IChainlinkAggregator.getRoundData, (r)),
            abi.encode(r, above, uint256(p.closeTime - 30), uint256(p.closeTime - 30), r)
        );
        vm.mockCall(
            address(btc),
            abi.encodeCall(IChainlinkAggregator.getRoundData, (r + 1)),
            abi.encode(r + 1, above, uint256(p.closeTime + 30), uint256(p.closeTime + 30), r + 1)
        );
    }

    // ------------------------------------------------------------------ helpers

    function _registerTemplates() internal {
        GuardianBatch batch = new GuardianBatch();
        vm.startPrank(guardian);
        (bool ok1,) = address(factory).call(batch.calldataFor(1, d.perplFunding));
        (bool ok2,) = address(factory).call(batch.calldataFor(2, d.priceAtTime));
        vm.stopPrank();
        assertTrue(ok1 && ok2, "guardian registers both templates");
    }

    function _toFeed(int256 e8) internal view returns (int256) {
        uint8 dec = btc.decimals();
        return dec >= 8 ? e8 * int256(10 ** (dec - 8)) : e8 / int256(10 ** (8 - dec));
    }

    function _fund(address who, uint256 amount) internal {
        deal(d.usdc, who, amount);
        vm.prank(who);
        usdc.approve(d.vault, type(uint256).max);
    }

    function _checkSolvent() internal view {
        assertGe(vault.surplus(), 0, "solvent");
        if (address(m) != address(0) && m.phase() != Phase.Settled) {
            (address y, address n) = m.tokens();
            uint256 sets = vault.ledger(address(m)).sets;
            assertEq(OutcomeToken(y).totalSupply(), sets, "YES = sets");
            assertEq(OutcomeToken(n).totalSupply(), sets, "NO = sets");
        }
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
    }
}
