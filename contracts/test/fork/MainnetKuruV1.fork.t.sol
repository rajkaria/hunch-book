// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {GuardianBatch} from "../../script/GuardianBatch.s.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../../src/core/HunchRouter.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {GraduationRule, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../../src/interfaces/ITemplates.sol";
import {IChainlinkAggregator} from "../../src/interfaces/external/IChainlinkAggregator.sol";
import {IKuruMarginAccount} from "../../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {IKuruRouter} from "../../src/interfaces/external/IKuruRouter.sol";

interface IUsdcV1 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IChainlinkLatestV1 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IOwnedV1 {
    function owner() external view returns (address);
}

/// The mainnet money paths on Kuru v1, on a fork of Monad mainnet: the real deploy script (Kuru v1 is
/// the mainnet default), the mainnet graduation rule, Circle USDC moved from a real holder (impersonated,
/// no `deal`), Kuru's mainnet Router, MarginAccount and order book, and Chainlink's BTC/USD feed.
///
///   (a) No Kuru book: graduation reverts and waits, the pool locks, settles and pays every winner in
///       full; a market nobody can settle voids and refunds every stake in full. No money waits on Kuru.
///   (b) Kuru's owner creates the book with the Graduator's parameters (at the address computeAddress
///       predicts): anyone registers it, graduate() works, and trades route through Kuru's book.
///   (c) Router.deployProxy is owner-only on mainnet: our wallets and strangers are refused.
///
/// The only stand-in, as in MainnetRehearsal.fork.t.sol: a fork cannot see future Chainlink rounds, so
/// the two rounds around the close time are mocked on the real feed. Every test skips when the mainnet
/// RPC is unreachable.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/MainnetKuruV1.fork.t.sol -vv
contract MainnetKuruV1ForkTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xD3B10;
    /// Kuru's `Unauthorized()` (Solady Ownable), what a non-owner gets from deployProxy.
    bytes4 internal constant KURU_UNAUTHORIZED = 0x82b42900;
    /// The recommended mainnet graduation rule (GRADUATION_MIN_POOL=200, GRADUATION_MIN_STAKERS=5).
    uint256 internal constant MIN_POOL_USDC = 200;
    uint256 internal constant MIN_STAKERS = 5;

    /// Circle USDC holders on Monad mainnet, tried in order (the first with enough USDC is used).
    address[3] internal holders = [
        0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e,
        0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5, // Kuru's MarginAccount
        0x63e48B725540A3Db24ACF6682a29f877808C53F2
    ];

    string internal json;
    Deploy.Deployed internal d;
    IUsdcV1 internal usdc;
    HunchBookFactory internal factory;
    CollateralVault internal vault;
    Graduator internal graduator;
    HunchRouter internal router;
    IKuruRouter internal kuru;
    IKuruMarginAccount internal margin;
    IChainlinkAggregator internal btc;
    address internal holder;
    bool internal forked;

    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("fee recipient");
    address internal outsider = makeAddr("outsider");
    address internal maker = makeAddr("maker");
    address internal trader = makeAddr("trader");
    address internal creator = makeAddr("creator");
    address internal keeper;

    Market internal m;
    PriceAtTimeParams internal p;
    uint80 internal lastRound;
    address[] internal yesStakers;
    address[] internal noStakers;
    mapping(address => uint256) internal staked;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        try vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz"))) returns (uint256) {
            forked = true;
        } catch {
            vm.skip(true, "Monad mainnet RPC unreachable");
            return;
        }
        assertEq(block.chainid, 143);
        keeper = vm.parseJsonAddress(json, ".wallets.keeper");

        vm.deal(vm.addr(DEPLOYER_KEY), 100 ether);
        d = new Deploy()
            .deployWith(
                DEPLOYER_KEY,
                guardian,
                feeRecipient,
                Deploy.Options({kuruVersion: 1, stack: "", wireKuru: true, hunchVenue: false})
            );
        usdc = IUsdcV1(d.usdc);
        factory = HunchBookFactory(d.factory);
        vault = CollateralVault(d.vault);
        graduator = Graduator(d.graduator);
        router = HunchRouter(d.router);
        kuru = IKuruRouter(vm.parseJsonAddress(json, ".external.kuru.router"));
        margin = IKuruMarginAccount(vm.parseJsonAddress(json, ".external.kuru.marginAccount"));
        btc = IChainlinkAggregator(vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']"));

        // The guardian registers template 2 with the mainnet rule, as GuardianBatch.s.sol would.
        GuardianBatch batch = new GuardianBatch();
        GraduationRule memory rule = batch.ruleOf(MIN_POOL_USDC, MIN_STAKERS);
        bytes memory addTemplate2 = batch.calldataFor(2, d.priceAtTime, rule);
        vm.prank(guardian);
        (bool ok,) = address(factory).call(addTemplate2);
        assertTrue(ok, "guardian registers template 2");

        holder = _pickHolder(20_000e6);
    }

    // ------------------------------------------------------------------ (c) owner-only books

    function test_deployProxyIsOwnerOnlyOnMainnet() public {
        _createMarket();
        address[4] memory refused = [outsider, keeper, vm.parseJsonAddress(json, ".wallets.maker"), d.guardian];
        for (uint256 i; i < refused.length; ++i) {
            _expectDeployProxyRefused(refused[i]);
        }
        // Our Graduator knows it cannot create books here, and says so instead of trying.
        assertFalse(graduator.canCreateBooks());
        vm.expectRevert(IGraduator.CreationNotSupported.selector);
        graduator.createBook(address(m));
    }

    // ------------------------------------------------------------------ (a) no book: the pool path

    function test_noKuruBook_graduationWaits_poolSettlesAndPaysWinnersInFull() public {
        _createMarket();
        _fillPool();
        assertTrue(m.graduationRuleMet(), "five stakers and 200 USDC meet the mainnet rule");

        // No Kuru book: graduation reverts (and changes nothing), from the keeper or anyone.
        assertEq(_predictedBook().code.length, 0, "no book at the predicted address");
        vm.prank(keeper);
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();
        vm.prank(outsider);
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();
        assertEq(uint8(m.phase()), uint8(Phase.Pool));

        // Lock: staking and graduation stop; the pool waits for the close.
        vm.warp(p.lockTime);
        assertEq(uint8(m.phase()), uint8(Phase.PoolLocked));
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.PoolLocked));
        m.graduate();

        uint256 poolBefore = vault.ledger(address(m)).pool;
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        assertEq(poolBefore, _totalStaked());

        // Close and settle from the Chainlink round that brackets the close time (YES).
        vm.warp(p.closeTime + 10 minutes);
        m.settle(abi.encode(_mockRoundsAroundClose(true)));
        assertEq(uint8(m.phase()), uint8(Phase.Settled));
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));

        // Every winner is paid stake + share of the losing side - 2% fee on winnings; losers get nothing.
        (uint256 yesTotal, uint256 noTotal,) = m.poolTotals();
        uint256 paidOut;
        uint256 fees;
        for (uint256 i; i < yesStakers.length; ++i) {
            address u = yesStakers[i];
            uint256 gross = staked[u] * noTotal / yesTotal;
            uint256 fee = (gross * 200 + 9999) / 10_000;
            uint256 before = usdc.balanceOf(u);
            vm.prank(u);
            m.claimPool();
            assertEq(usdc.balanceOf(u) - before, staked[u] + gross - fee, "winner paid in full");
            paidOut += staked[u] + gross - fee;
            fees += fee;
        }
        for (uint256 i; i < noStakers.length; ++i) {
            vm.prank(noStakers[i]);
            vm.expectRevert(IMarket.NothingToClaim.selector);
            m.claimPool();
        }
        assertEq(vault.ledger(address(m)).pool, 0, "the pool is fully paid out (dust to fees)");
        assertEq(vaultBefore - usdc.balanceOf(address(vault)), paidOut, "USDC left the vault to the winners");
        assertGe(poolBefore - paidOut, fees, "only fees and rounding dust stay");
        assertGe(vault.surplus(), 0, "solvent");
    }

    /// A pool whose market cannot be settled before its deadline (no round, a dead feed) voids, and every
    /// stake comes back in full: no fee, no Kuru, no one's permission.
    function test_noKuruBook_unsettledPoolVoidsAndRefundsEveryStake() public {
        _createMarket();
        _fillPool();
        vm.warp(m.window().settleDeadline + 1);
        vm.prank(outsider);
        m.voidIfExpired();
        assertEq(uint8(m.phase()), uint8(Phase.Voided));
        address[] memory all = _allStakers();
        for (uint256 i; i < all.length; ++i) {
            uint256 before = usdc.balanceOf(all[i]);
            vm.prank(all[i]);
            m.claimPool();
            assertEq(usdc.balanceOf(all[i]) - before, staked[all[i]], "stake refunded in full");
        }
        assertEq(vault.ledger(address(m)).pool, 0);
        assertGe(vault.surplus(), 0, "solvent");
    }

    // ------------------------------------------------------------------ (b) Kuru creates the book

    function test_kuruCreatedBook_registerGraduateTradeSettleRedeem() public {
        _createMarket();
        address predicted = _predictedBook();

        // Kuru can create the book as soon as the market exists, before the pool fills.
        address book = _kuruCreatesBook();
        assertEq(book, predicted, "the book lands where computeAddress said, so the request can name it");
        assertTrue(margin.verifiedMarket(book));

        // A real Kuru book for the same YES token with any other parameter (here a 0.1% taker fee) is
        // refused, and so is anything Kuru did not create; the right one is registered by a stranger.
        address lookAlike = _kuruCreatesBookWithFees(10, 0);
        assertTrue(margin.verifiedMarket(lookAlike));
        vm.prank(outsider);
        vm.expectRevert(IGraduator.BookMismatch.selector);
        graduator.registerBook(address(m), lookAlike);
        vm.prank(outsider);
        vm.expectRevert(IGraduator.BookMismatch.selector);
        graduator.registerBook(address(m), address(kuru));
        vm.prank(outsider);
        graduator.registerBook(address(m), book);
        assertEq(graduator.bookOf(address(m)), book);

        // Registered early, graduation still waits for the rule.
        vm.expectRevert(IMarket.GraduationRuleNotMet.selector);
        m.graduate();
        _fillPool();
        vm.prank(keeper);
        m.graduate();
        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        assertEq(m.book(), book);
        m.claimTokensFor(_allStakers());
        _checkSets();

        _makerQuotes(book);
        _traderTradesThroughKuru();
        _settleAndRedeem();
    }

    /// A maker quotes YES 0.54 / 0.58 on Kuru's book from minted sets.
    function _makerQuotes(address book) internal {
        (address yes,) = m.tokens();
        _fund(maker, 1000e6);
        vm.startPrank(maker);
        vault.mintSets(address(m), 300e6, maker);
        OutcomeToken(yes).approve(address(margin), type(uint256).max);
        usdc.approve(address(margin), type(uint256).max);
        margin.deposit(maker, yes, 300e6);
        margin.deposit(maker, d.usdc, 300e6);
        IKuruOrderBook(book).addSellOrder(580_000, 200e6, true);
        IKuruOrderBook(book).addBuyOrder(540_000, 200e6, true);
        vm.stopPrank();
        _checkSets();
    }

    /// A trader buys YES through the router (the fill is the maker's Kuru order), sells half back into
    /// the maker's bid, and buys NO (a set minted with a flash loan, its YES sold on the book).
    function _traderTradesThroughKuru() internal {
        (address yes,) = m.tokens();
        _fund(trader, 200e6);
        uint256 makerUsdcBefore = margin.getBalance(maker, d.usdc);
        vm.startPrank(trader);
        usdc.approve(address(router), type(uint256).max);
        uint256 bought = router.buyYes(address(m), 29e6, 49e6, block.timestamp + 1 hours);
        assertEq(bought, 50e6, "29 USDC at 0.58 buys 50 YES on Kuru's book");
        assertEq(margin.getBalance(maker, d.usdc) - makerUsdcBefore, 29e6, "the maker's ask was filled on Kuru");

        OutcomeToken(yes).approve(address(router), type(uint256).max);
        assertEq(router.sellYes(address(m), 25e6, 13e6, block.timestamp + 1 hours), 13.5e6, "25 YES at 0.54");
        uint256 spent = router.buyNo(address(m), 20e6, 10e6, block.timestamp + 1 hours);
        assertEq(spent, 20e6 - 10.8e6, "20 NO cost 20 USDC of sets less 20 YES sold at 0.54");
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
        _checkSets();
    }

    /// Close, settle (YES), and the trader redeems YES at $1 less the fee; NO is worth nothing.
    function _settleAndRedeem() internal {
        (address yes, address no) = m.tokens();
        vm.warp(p.closeTime + 10 minutes);
        m.settle(abi.encode(_mockRoundsAroundClose(true)));
        assertEq(uint8(m.outcome()), uint8(Outcome.Yes));
        uint256 held = OutcomeToken(yes).balanceOf(trader);
        assertEq(held, 25e6);
        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        uint256 paid = vault.redeem(address(m), Side.Yes, held, trader);
        assertEq(usdc.balanceOf(trader) - before, paid);
        assertGt(paid, held * 98 / 100, "fee is at most 2 cents a token");
        assertEq(OutcomeToken(no).balanceOf(trader), 20e6, "NO tokens remain, worth nothing");
        assertGe(vault.surplus(), 0, "solvent");
    }

    // ------------------------------------------------------------------ helpers

    function _createMarket() internal {
        (uint80 latest, int256 answer,, uint256 updatedAt,) = IChainlinkLatestV1(address(btc)).latestRoundData();
        assertGt(updatedAt, 0);
        lastRound = latest;
        uint8 dec = btc.decimals();
        int256 strikeE8 = dec >= 8 ? answer / int256(10 ** (dec - 8)) : answer * int256(10 ** (8 - dec));
        p = PriceAtTimeParams({
            source: 0,
            feed: address(btc),
            pythId: bytes32(0),
            strikeE8: strikeE8,
            lockTime: uint64(block.timestamp + 6 hours),
            closeTime: uint64(block.timestamp + 7 hours)
        });
        _fund(creator, 100e6);
        vm.prank(creator);
        m = Market(payable(factory.createMarket(2, abi.encode(p), Side.Yes, 10e6)));
        yesStakers.push(creator);
        staked[creator] = 10e6;
    }

    /// Five more people: three YES, two NO, 220 USDC in all with the creator's 10.
    function _fillPool() internal {
        for (uint256 i; i < 5; ++i) {
            address u = makeAddr(string.concat("staker ", vm.toString(i)));
            uint256 amount = i < 3 ? 30e6 : 60e6;
            _fund(u, amount);
            vm.prank(u);
            m.stake(i < 3 ? Side.Yes : Side.No, amount);
            staked[u] += amount;
            if (i < 3) yesStakers.push(u);
            else noStakers.push(u);
        }
    }

    function _kuruCreatesBook() internal returns (address) {
        IGraduator.BookParams memory bp = graduator.bookParams();
        return _kuruCreatesBookWithFees(bp.takerFeeBps, bp.makerFeeBps);
    }

    /// `who` calls deployProxy with this market's exact book parameters and gets Kuru's Unauthorized().
    function _expectDeployProxyRefused(address who) internal {
        IGraduator.BookParams memory bp = graduator.bookParams();
        (address yes,) = m.tokens();
        uint96 maxSize = uint96(m.caps().poolCap);
        vm.prank(who);
        vm.expectRevert(KURU_UNAUTHORIZED);
        kuru.deployProxy(
            0,
            yes,
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
    }

    /// Kuru's owner creates a YES/USDC book with the Graduator's parameters but the fees given.
    function _kuruCreatesBookWithFees(uint256 takerFeeBps, uint256 makerFeeBps) internal returns (address book) {
        IGraduator.BookParams memory bp = graduator.bookParams();
        (address yes,) = m.tokens();
        uint96 maxSize = uint96(m.caps().poolCap);
        vm.prank(IOwnedV1(address(kuru)).owner());
        book = kuru.deployProxy(
            0,
            yes,
            d.usdc,
            bp.sizePrecision,
            bp.pricePrecision,
            bp.tickSize,
            bp.minSize,
            maxSize,
            takerFeeBps,
            makerFeeBps,
            bp.kuruAmmSpread
        );
    }

    /// Where Kuru's deployProxy puts this market's book (what the keeper's book request names).
    function _predictedBook() internal view returns (address) {
        IGraduator.BookParams memory bp = graduator.bookParams();
        (address yes,) = m.tokens();
        return kuru.computeAddress(
            yes,
            d.usdc,
            bp.sizePrecision,
            bp.pricePrecision,
            bp.tickSize,
            bp.minSize,
            uint96(m.caps().poolCap),
            bp.takerFeeBps,
            bp.makerFeeBps,
            bp.kuruAmmSpread,
            address(0),
            false
        );
    }

    function _mockRoundsAroundClose(bool yesWins) internal returns (uint80 r) {
        r = lastRound + 1;
        int256 e8 = yesWins ? p.strikeE8 + 1000e8 : p.strikeE8 - 1000e8;
        uint8 dec = btc.decimals();
        int256 value = dec >= 8 ? e8 * int256(10 ** (dec - 8)) : e8 / int256(10 ** (8 - dec));
        vm.mockCall(
            address(btc),
            abi.encodeCall(IChainlinkAggregator.getRoundData, (r)),
            abi.encode(r, value, uint256(p.closeTime - 30), uint256(p.closeTime - 30), r)
        );
        vm.mockCall(
            address(btc),
            abi.encodeCall(IChainlinkAggregator.getRoundData, (r + 1)),
            abi.encode(r + 1, value, uint256(p.closeTime + 30), uint256(p.closeTime + 30), r + 1)
        );
    }

    /// The first listed holder with at least `need` USDC. Falls back to `deal` only if none has it.
    function _pickHolder(uint256 need) internal returns (address) {
        for (uint256 i; i < holders.length; ++i) {
            if (usdc.balanceOf(holders[i]) >= need) return holders[i];
        }
        console2.log("no listed USDC holder has enough on this block: falling back to deal");
        address h = makeAddr("usdc holder");
        deal(d.usdc, h, need);
        return h;
    }

    /// Moves real USDC from the holder to `who` and approves the vault.
    function _fund(address who, uint256 amount) internal {
        vm.prank(holder);
        assertTrue(usdc.transfer(who, amount));
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _allStakers() internal view returns (address[] memory all) {
        all = new address[](yesStakers.length + noStakers.length);
        for (uint256 i; i < yesStakers.length; ++i) {
            all[i] = yesStakers[i];
        }
        for (uint256 i; i < noStakers.length; ++i) {
            all[yesStakers.length + i] = noStakers[i];
        }
    }

    function _totalStaked() internal view returns (uint256 t) {
        address[] memory all = _allStakers();
        for (uint256 i; i < all.length; ++i) {
            t += staked[all[i]];
        }
    }

    /// Equal YES and NO supply, both equal to the sets the vault holds USDC for.
    function _checkSets() internal view {
        (address y, address n) = m.tokens();
        ICollateralVault.Ledger memory l = vault.ledger(address(m));
        assertEq(OutcomeToken(y).totalSupply(), l.sets, "YES = sets");
        assertEq(OutcomeToken(n).totalSupply(), l.sets, "NO = sets");
        assertGe(vault.surplus(), 0, "solvent");
    }
}
