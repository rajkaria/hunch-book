// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {GraduationRule, MarketCaps, Outcome, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

contract FactoryTest is BaseTest {
    // ---- creation ----

    function test_create_registersMarketDeterministically() public {
        Window memory w = _timeWindow();
        bytes memory params = abi.encode(w);
        bytes32 key = keccak256(abi.encode(TEMPLATE, params));
        address predicted = LibClone.predictDeterministicAddress(address(marketImpl), key, address(factory));

        vm.expectEmit(address(factory));
        emit IHunchBookFactory.MarketCreated(predicted, TEMPLATE, key, creator, params);
        vm.prank(creator);
        address m = factory.createMarket(TEMPLATE, params, Side.No, CREATOR_MIN);

        assertEq(m, predicted);
        assertEq(factory.marketOf(key), m);
        assertEq(factory.marketKey(TEMPLATE, params), key);
        assertTrue(factory.isMarket(m));
        assertEq(factory.marketCount(), 1);
        assertEq(factory.marketAt(0), m);
        assertEq(address(Market(payable(m)).resolver()), address(resolver));
        assertEq(Market(payable(m)).templateId(), TEMPLATE);
        assertEq(Market(payable(m)).factory(), address(factory));
        assertEq(Market(payable(m)).vault(), address(vault));
        assertEq(keccak256(Market(payable(m)).params()), keccak256(params));
        (address y, address n) = Market(payable(m)).tokens();
        assertEq(OutcomeToken(y).name(), "Hunch Book #1 YES");
        assertEq(OutcomeToken(n).symbol(), "HB1-NO");
        assertEq(OutcomeToken(y).decimals(), 6);
        assertEq(OutcomeToken(y).market(), m);
    }

    function test_create_oneMarketPerTemplateAndParams() public {
        bytes memory params = abi.encode(_timeWindow());
        vm.startPrank(creator);
        factory.createMarket(TEMPLATE, params, Side.Yes, CREATOR_MIN);
        vm.expectRevert(IHunchBookFactory.MarketExists.selector);
        factory.createMarket(TEMPLATE, params, Side.No, CREATOR_MIN);
        vm.stopPrank();
    }

    function test_create_revertsForUnknownTemplate() public {
        vm.prank(creator);
        vm.expectRevert(IHunchBookFactory.UnknownTemplate.selector);
        factory.createMarket(99, abi.encode(_timeWindow()), Side.Yes, CREATOR_MIN);
    }

    function test_create_revertsBelowCreatorMinimum() public {
        vm.prank(creator);
        vm.expectRevert(IHunchBookFactory.FirstStakeTooSmall.selector);
        factory.createMarket(TEMPLATE, abi.encode(_timeWindow()), Side.Yes, CREATOR_MIN - 1);
    }

    function test_create_revertsOnBadWindows() public {
        Window memory w = _timeWindow();
        w.lock = uint64(block.timestamp);
        _expectBadWindow(w);

        w = _timeWindow();
        w.close = w.lock - 1;
        _expectBadWindow(w);

        w = _timeWindow();
        w.settleDeadline = w.close;
        _expectBadWindow(w);

        w = _blockWindow();
        w.lock = uint64(block.number);
        _expectBadWindow(w);

        w = _blockWindow();
        w.settleDeadline = uint64(block.timestamp);
        _expectBadWindow(w);
    }

    function _expectBadWindow(Window memory w) internal {
        vm.prank(creator);
        vm.expectRevert(IHunchBookFactory.BadWindow.selector);
        factory.createMarket(TEMPLATE, abi.encode(w), Side.Yes, CREATOR_MIN);
    }

    function test_create_respectsCreationPause() public {
        vm.prank(guardian);
        factory.setCreationPaused(true);
        vm.prank(creator);
        vm.expectRevert(IHunchBookFactory.CreationIsPaused.selector);
        factory.createMarket(TEMPLATE, abi.encode(_timeWindow()), Side.Yes, CREATOR_MIN);
    }

    // ---- guardian powers and their limits ----

    function test_guardianOnly() public {
        vm.startPrank(users[0]);
        vm.expectRevert(IHunchBookFactory.OnlyGuardian.selector);
        factory.setCreationPaused(true);
        vm.expectRevert(IHunchBookFactory.OnlyGuardian.selector);
        factory.setGraduationPaused(true);
        vm.expectRevert(IHunchBookFactory.OnlyGuardian.selector);
        factory.addTemplate(2, IResolver(address(resolver)), _rule());
        vm.expectRevert(IHunchBookFactory.OnlyGuardian.selector);
        factory.setCaps(_caps());
        vm.expectRevert(IHunchBookFactory.OnlyGuardian.selector);
        factory.setCollateralCap(1);
        vm.expectRevert(IHunchBookFactory.OnlyGuardian.selector);
        factory.transferGuardian(users[0]);
        vm.stopPrank();
    }

    function test_templatesAreAppendOnlyAndValidated() public {
        MockResolver other = new MockResolver();
        vm.startPrank(guardian);
        vm.expectRevert(IHunchBookFactory.TemplateExists.selector);
        factory.addTemplate(TEMPLATE, IResolver(address(other)), _rule());
        vm.expectRevert(IHunchBookFactory.ZeroAddress.selector);
        factory.addTemplate(2, IResolver(address(0)), _rule());
        GraduationRule memory r = _rule();
        r.minChanceBps = r.maxChanceBps;
        vm.expectRevert(IHunchBookFactory.BadRule.selector);
        factory.addTemplate(2, IResolver(address(resolver)), r);
        r = _rule();
        r.maxChanceBps = 10_001;
        vm.expectRevert(IHunchBookFactory.BadRule.selector);
        factory.addTemplate(2, IResolver(address(resolver)), r);
        r = _rule();
        r.minStakers = 0;
        vm.expectRevert(IHunchBookFactory.BadRule.selector);
        factory.addTemplate(2, IResolver(address(resolver)), r);
        factory.addTemplate(2, IResolver(address(resolver)), _rule());
        vm.stopPrank();
        assertEq(address(factory.resolverOf(2)), address(resolver));
        assertEq(factory.templateOf(2).rule.minPool, 500e6);
    }

    function test_capsApplyOnlyToNewMarkets() public {
        Market before = _createDefault();
        MarketCaps memory c = _caps();
        c.walletCap = 200e6;
        c.poolCap = 2000e6;
        vm.prank(guardian);
        factory.setCaps(c);
        Market afterChange = _createDefault();
        assertEq(before.caps().walletCap, WALLET_CAP);
        assertEq(afterChange.caps().walletCap, 200e6);
        _stake(before, users[0], Side.Yes, 500e6); // old cap still applies
        vm.prank(users[0]);
        vm.expectRevert(IMarket.WalletCapExceeded.selector);
        afterChange.stake(Side.Yes, 500e6);
    }

    function test_capsAreValidated() public {
        MarketCaps memory c = _caps();
        c.minStake = 0;
        _expectBadCaps(c);
        c = _caps();
        c.creatorMinStake = c.minStake - 1;
        _expectBadCaps(c);
        c = _caps();
        c.walletCap = c.creatorMinStake - 1;
        _expectBadCaps(c);
        c = _caps();
        c.poolCap = c.walletCap - 1;
        _expectBadCaps(c);
        c = _caps();
        c.poolCap = uint128(type(uint96).max) + 1;
        _expectBadCaps(c);
    }

    function _expectBadCaps(MarketCaps memory c) internal {
        vm.prank(guardian);
        vm.expectRevert(IHunchBookFactory.BadCaps.selector);
        factory.setCaps(c);
    }

    function test_guardianTransferIsTwoStep() public {
        address next = makeAddr("next guardian");
        vm.prank(guardian);
        factory.transferGuardian(next);
        assertEq(factory.guardian(), guardian);
        vm.prank(users[0]);
        vm.expectRevert(IHunchBookFactory.OnlyPendingGuardian.selector);
        factory.acceptGuardian();
        vm.prank(next);
        factory.acceptGuardian();
        assertEq(factory.guardian(), next);
        assertEq(factory.pendingGuardian(), address(0));
    }

    function test_feeRecipientRotatesItself() public {
        address next = makeAddr("next recipient");
        vm.prank(guardian);
        vm.expectRevert(IHunchBookFactory.OnlyFeeRecipient.selector);
        factory.setFeeRecipient(next);
        vm.prank(feeRecipient);
        vm.expectRevert(IHunchBookFactory.ZeroAddress.selector);
        factory.setFeeRecipient(address(0));
        vm.prank(feeRecipient);
        factory.setFeeRecipient(next);
        assertEq(factory.feeRecipient(), next);
    }

    function test_graduatorIsWiredOnceByTheDeployer() public {
        vm.expectRevert(IHunchBookFactory.GraduatorAlreadySet.selector);
        factory.setGraduator(users[0]);
        HunchBookFactory f2 =
            new HunchBookFactory(address(usdc), address(marketImpl), guardian, feeRecipient, _caps(), COLLATERAL_CAP);
        vm.prank(guardian);
        vm.expectRevert(IHunchBookFactory.OnlyDeployer.selector);
        f2.setGraduator(users[0]);
        vm.expectRevert(IHunchBookFactory.ZeroAddress.selector);
        f2.setGraduator(address(0));
        f2.setGraduator(users[0]);
        assertEq(f2.graduator(), users[0]);
    }

    /// Deploys through an external call, so `vm.expectRevert` checks the deployment itself.
    function deployFactory(address u, address g) external returns (address) {
        return address(new HunchBookFactory(u, address(marketImpl), g, feeRecipient, _caps(), COLLATERAL_CAP));
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(IHunchBookFactory.ZeroAddress.selector);
        this.deployFactory(address(0), guardian);
        vm.expectRevert(IHunchBookFactory.ZeroAddress.selector);
        this.deployFactory(address(usdc), address(0));
        assertTrue(this.deployFactory(address(usdc), guardian) != address(0));
    }

    /// PROTOCOL.md §7.3 and invariant 6: with every pause on, existing markets still settle,
    /// redeem, merge and refund.
    function test_guardianCannotBlockSettlementRedemptionMergeOrRefunds() public {
        Market g = _graduated();
        Market p = _createDefault();
        _stake(p, users[11], Side.No, 10e6);
        vm.prank(users[12]);
        vault.mintSets(address(g), 10e6, users[12]);

        vm.startPrank(guardian);
        factory.setCreationPaused(true);
        factory.setGraduationPaused(true);
        factory.setCollateralCap(0);
        vm.stopPrank();

        vm.prank(users[12]);
        vault.mergeSets(address(g), 5e6, users[12]);

        _settle(g, Outcome.Yes);
        vm.startPrank(users[0]);
        g.claimTokens();
        vault.redeem(address(g), Side.Yes, _yes(g).balanceOf(users[0]), users[0]);
        vm.stopPrank();

        vm.warp(p.window().settleDeadline + 1);
        p.voidIfExpired();
        vm.prank(users[11]);
        p.claimPool();
        _assertSolvent();
    }

    function test_noFunctionLetsAnyoneSetAnOutcome() public {
        // The only writers of `outcome` are settle and proveYes, both gated on the resolver's answer.
        Market m = _graduated();
        _toClose(m);
        resolver.setAnswer(Outcome.Unresolved);
        vm.prank(guardian);
        vm.expectRevert(IMarket.NotResolved.selector);
        m.settle("");
        assertEq(uint8(m.outcome()), uint8(Outcome.Unresolved));
        assertEq(uint8(vault.ledger(address(m)).status), uint8(ICollateralVault.Status.Open));
    }
}

contract OutcomeTokenTest is BaseTest {
    function test_onlyVaultMintsAndBurns() public {
        Market m = _createDefault();
        OutcomeToken y = _yes(m);
        vm.expectRevert(OutcomeToken.OnlyVault.selector);
        y.mint(users[0], 1);
        vm.expectRevert(OutcomeToken.OnlyVault.selector);
        y.burn(users[0], 1);
        assertEq(y.vault(), address(vault));
        assertEq(uint8(y.side()), uint8(Side.Yes));
    }

    function test_initializeOnce() public {
        Market m = _createDefault();
        OutcomeToken y = _yes(m);
        vm.expectRevert(OutcomeToken.AlreadyInitialized.selector);
        y.initialize(users[0], users[0], Side.Yes, "x", "x");
        OutcomeToken impl = OutcomeToken(vault.tokenImplementation());
        vm.expectRevert(OutcomeToken.AlreadyInitialized.selector);
        impl.initialize(users[0], users[0], Side.Yes, "x", "x");
    }

    function test_permitWorksAndNoPermit2InfiniteAllowance() public {
        Market m = _graduated();
        (address owner, uint256 pk) = makeAddrAndKey("owner");
        vm.prank(users[0]);
        vault.mintSets(address(m), 5e6, owner);
        OutcomeToken y = _yes(m);
        address spender = makeAddr("spender");
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                5e6,
                0,
                block.timestamp + 1
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", y.DOMAIN_SEPARATOR(), structHash)));
        y.permit(owner, spender, 5e6, block.timestamp + 1, v, r, s);
        assertEq(y.allowance(owner, spender), 5e6);
        assertEq(y.allowance(owner, 0x000000000022D473030F116dDEE9F6B43aC78BA3), 0);
    }
}
