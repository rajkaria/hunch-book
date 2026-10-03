// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";

contract MarketStakingTest is BaseTest {
    function test_create_recordsCreatorFirstStake() public {
        Market m = _createDefault();
        (uint256 y, uint256 n, uint32 stakers) = m.poolTotals();
        assertEq(y, CREATOR_MIN);
        assertEq(n, 0);
        assertEq(stakers, 1);
        (uint256 cy, uint256 cn) = m.stakeOf(creator);
        assertEq(cy, CREATOR_MIN);
        assertEq(cn, 0);
        assertEq(vault.ledger(address(m)).pool, CREATOR_MIN);
        assertEq(usdc.balanceOf(address(vault)), CREATOR_MIN);
        assertEq(m.creator(), creator);
        assertEq(m.marketId(), 1);
        assertEq(uint8(m.phase()), uint8(Phase.Pool));
        _assertSolvent();
    }

    function test_stake_pullsUsdcAndUpdatesTotals() public {
        Market m = _createDefault();
        address u = users[0];
        uint256 before = usdc.balanceOf(u);
        vm.expectEmit(address(m));
        emit IMarket.Staked(u, Side.No, 7e6, CREATOR_MIN, 7e6);
        _stake(m, u, Side.No, 7e6);
        assertEq(usdc.balanceOf(u), before - 7e6);
        (uint256 y, uint256 n, uint32 stakers) = m.poolTotals();
        assertEq(y, CREATOR_MIN);
        assertEq(n, 7e6);
        assertEq(stakers, 2);
        assertEq(vault.ledger(address(m)).pool, CREATOR_MIN + 7e6);
        _assertSolvent();
    }

    function test_stake_countsDistinctStakersAcrossSides() public {
        Market m = _createDefault();
        _stake(m, users[0], Side.Yes, 2e6);
        _stake(m, users[0], Side.No, 2e6);
        _stake(m, users[0], Side.Yes, 2e6);
        (,, uint32 stakers) = m.poolTotals();
        assertEq(stakers, 2);
        (uint256 y, uint256 n) = m.stakeOf(users[0]);
        assertEq(y, 4e6);
        assertEq(n, 2e6);
    }

    function test_stake_revertsBelowMinimum() public {
        Market m = _createDefault();
        vm.prank(users[0]);
        vm.expectRevert(IMarket.StakeTooSmall.selector);
        m.stake(Side.Yes, MIN_STAKE - 1);
    }

    function test_stake_revertsAboveWalletCapAcrossBothSides() public {
        Market m = _createDefault();
        _stake(m, users[0], Side.Yes, 600e6);
        vm.prank(users[0]);
        vm.expectRevert(IMarket.WalletCapExceeded.selector);
        m.stake(Side.No, 400e6 + 1);
        _stake(m, users[0], Side.No, 400e6);
    }

    function test_stake_revertsAbovePoolCap() public {
        Market m = _createDefault();
        for (uint256 i; i < 4; ++i) {
            _stake(m, users[i], Side.Yes, WALLET_CAP);
        }
        // 4,005 staked; 995 left.
        _stake(m, users[4], Side.No, POOL_CAP - 4000e6 - CREATOR_MIN);
        vm.prank(users[5]);
        vm.expectRevert(IMarket.PoolCapExceeded.selector);
        m.stake(Side.No, MIN_STAKE);
    }

    function test_stake_revertsAboveCollateralCap() public {
        Market m = _createDefault();
        vm.prank(guardian);
        factory.setCollateralCap(CREATOR_MIN + 10e6);
        _stake(m, users[0], Side.Yes, 10e6);
        vm.prank(users[1]);
        vm.expectRevert(ICollateralVault.CollateralCapExceeded.selector);
        m.stake(Side.Yes, MIN_STAKE);
    }

    function test_stake_revertsAtAndAfterLock() public {
        Market m = _createDefault();
        vm.warp(m.window().lock);
        assertEq(uint8(m.phase()), uint8(Phase.PoolLocked));
        vm.prank(users[0]);
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.PoolLocked));
        m.stake(Side.Yes, MIN_STAKE);
    }

    function test_stake_blockClockLocksOnBlockNumber() public {
        Market m = _create(_blockWindow(), Side.No, CREATOR_MIN);
        Window memory w = m.window();
        vm.warp(block.timestamp + 365 days); // time does not matter for block-clock markets
        assertEq(uint8(m.phase()), uint8(Phase.Pool));
        vm.roll(w.lock - 1);
        _stake(m, users[0], Side.Yes, MIN_STAKE);
        vm.roll(w.lock);
        assertEq(uint8(m.phase()), uint8(Phase.PoolLocked));
    }

    function test_stakeFor_payerPaysUserIsCredited() public {
        Market m = _createDefault();
        address payer = users[0];
        address beneficiary = makeAddr("beneficiary");
        uint256 before = usdc.balanceOf(payer);
        vm.prank(payer);
        m.stakeFor(beneficiary, Side.No, 3e6);
        assertEq(usdc.balanceOf(payer), before - 3e6);
        (, uint256 n) = m.stakeOf(beneficiary);
        assertEq(n, 3e6);
        (, uint256 pn) = m.stakeOf(payer);
        assertEq(pn, 0);
    }

    function test_stakeFor_revertsForZeroUser() public {
        Market m = _createDefault();
        vm.prank(users[0]);
        vm.expectRevert(Market.ZeroAddress.selector);
        m.stakeFor(address(0), Side.No, 3e6);
    }

    function test_stake_revertsAfterGraduation() public {
        Market m = _graduated();
        vm.prank(users[11]);
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.Graduated));
        m.stake(Side.Yes, MIN_STAKE);
    }

    function test_initialize_cannotBeCalledAgainOrOnImplementation() public {
        Market m = _createDefault();
        Market.InitParams memory p;
        vm.expectRevert(Market.AlreadyInitialized.selector);
        m.initialize(p);
        vm.expectRevert(Market.AlreadyInitialized.selector);
        marketImpl.initialize(p);
    }
}

contract MarketAuthorizationTest is BaseTest {
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function _sign(uint256 pk, address to, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, vm.addr(pk), to, value, block.timestamp - 1, block.timestamp + 1 hours, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_relayedStake_movesSignedUsdcAndCreditsUser() public {
        Market m = _createDefault();
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        usdc.mint(signer, 50e6);
        bytes32 salt = keccak256("s1");
        bytes memory sig = _sign(pk, address(m), 20e6, m.authorizationNonce(signer, Side.No, salt));

        vm.prank(makeAddr("relayer"));
        m.stakeWithAuthorization(signer, Side.No, 20e6, block.timestamp - 1, block.timestamp + 1 hours, salt, sig);

        assertEq(usdc.balanceOf(signer), 30e6);
        (, uint256 n) = m.stakeOf(signer);
        assertEq(n, 20e6);
        assertEq(vault.ledger(address(m)).pool, CREATOR_MIN + 20e6);
        assertEq(usdc.balanceOf(address(m)), 0);
        _assertSolvent();
    }

    function test_relayedStake_cannotBeRedirectedToTheOtherSide() public {
        Market m = _createDefault();
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        usdc.mint(signer, 50e6);
        bytes32 salt = keccak256("s1");
        bytes memory sig = _sign(pk, address(m), 20e6, m.authorizationNonce(signer, Side.No, salt));

        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        m.stakeWithAuthorization(signer, Side.Yes, 20e6, block.timestamp - 1, block.timestamp + 1 hours, salt, sig);
    }

    function test_relayedStake_cannotBeReplayed() public {
        Market m = _createDefault();
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        usdc.mint(signer, 50e6);
        bytes32 salt = keccak256("s1");
        bytes memory sig = _sign(pk, address(m), 20e6, m.authorizationNonce(signer, Side.No, salt));
        m.stakeWithAuthorization(signer, Side.No, 20e6, block.timestamp - 1, block.timestamp + 1 hours, salt, sig);
        vm.expectRevert(TestUSDC.AuthorizationAlreadyUsed.selector);
        m.stakeWithAuthorization(signer, Side.No, 20e6, block.timestamp - 1, block.timestamp + 1 hours, salt, sig);
    }

    function test_relayedStake_cannotBeUsedOnAnotherMarket() public {
        Market m1 = _createDefault();
        Market m2 = _createDefault();
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        usdc.mint(signer, 50e6);
        bytes32 salt = keccak256("s1");
        bytes memory sig = _sign(pk, address(m1), 20e6, m1.authorizationNonce(signer, Side.No, salt));
        // The signature names m1 as the payee, so it does not verify for m2.
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        m2.stakeWithAuthorization(signer, Side.No, 20e6, block.timestamp - 1, block.timestamp + 1 hours, salt, sig);
    }

    function test_relayedStake_respectsCapsAndPhase() public {
        Market m = _createDefault();
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        usdc.mint(signer, 2000e6);
        bytes32 salt = keccak256("s1");
        bytes memory sig = _sign(pk, address(m), WALLET_CAP + 1, m.authorizationNonce(signer, Side.No, salt));
        vm.expectRevert(IMarket.WalletCapExceeded.selector);
        m.stakeWithAuthorization(
            signer, Side.No, WALLET_CAP + 1, block.timestamp - 1, block.timestamp + 1 hours, salt, sig
        );

        vm.expectRevert(IMarket.BadAuthorization.selector);
        m.stakeWithAuthorization(signer, Side.No, 2e6, block.timestamp - 1, block.timestamp + 1 hours, salt, hex"1234");
    }
}

contract MarketGraduationTest is BaseTest {
    function test_graduate_mintsCompleteSetsAndOpensBook() public {
        Market m = _createDefault();
        _fillToRule(m);
        assertTrue(m.graduationRuleMet());
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 t = y + n;

        vm.expectEmit(address(m));
        emit IMarket.Graduated(t, y, n, y * 1e6 / t, address(uint160(0xB00C001)));
        m.graduate();

        assertEq(uint8(m.phase()), uint8(Phase.Graduated));
        assertTrue(m.graduated());
        assertEq(m.book(), graduator.bookOf(address(m)));
        ICollateralVault.Ledger memory l = vault.ledger(address(m));
        assertEq(l.pool, 0);
        assertEq(l.sets, t);
        assertEq(_yes(m).balanceOf(address(m)), t);
        assertEq(_no(m).balanceOf(address(m)), t);
        _assertSetsMatchSupply(m);
        _assertSolvent();
    }

    function test_graduate_revertsBelowMinPool() public {
        Market m = _createDefault();
        for (uint256 i; i < 10; ++i) {
            _stake(m, users[i], i % 2 == 0 ? Side.Yes : Side.No, 10e6);
        }
        assertFalse(m.graduationRuleMet());
        vm.expectRevert(IMarket.GraduationRuleNotMet.selector);
        m.graduate();
    }

    function test_graduate_revertsWithTooFewStakers() public {
        Market m = _createDefault();
        for (uint256 i; i < 8; ++i) {
            _stake(m, users[i], i % 2 == 0 ? Side.Yes : Side.No, 100e6);
        }
        (,, uint32 stakers) = m.poolTotals();
        assertEq(stakers, 9);
        vm.expectRevert(IMarket.GraduationRuleNotMet.selector);
        m.graduate();
    }

    function test_graduate_revertsWhenOneSided() public {
        Market m = _createDefault();
        for (uint256 i; i < 10; ++i) {
            _stake(m, users[i], Side.Yes, 60e6);
        }
        vm.expectRevert(IMarket.GraduationRuleNotMet.selector);
        m.graduate();
    }

    function test_graduate_revertsOutsideChanceBand() public {
        Market m = _createDefault();
        // YES 5 + 9×100 = 905, NO 20 → YES ≈ 97.8% > 97%.
        for (uint256 i; i < 9; ++i) {
            _stake(m, users[i], Side.Yes, 100e6);
        }
        _stake(m, users[9], Side.No, 20e6);
        assertFalse(m.graduationRuleMet());
        _stake(m, users[10], Side.No, 10e6); // NO 30 / 935 ≈ 3.2% → YES ≈ 96.8%
        assertTrue(m.graduationRuleMet());
    }

    function test_graduate_revertsAfterLock() public {
        Market m = _createDefault();
        _fillToRule(m);
        vm.warp(m.window().lock);
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.PoolLocked));
        m.graduate();
    }

    function test_graduate_revertsTwice() public {
        Market m = _graduated();
        vm.expectRevert(abi.encodeWithSelector(IMarket.WrongPhase.selector, Phase.Graduated));
        m.graduate();
    }

    function test_graduate_respectsGuardianPause() public {
        Market m = _createDefault();
        _fillToRule(m);
        vm.prank(guardian);
        factory.setGraduationPaused(true);
        vm.expectRevert(IMarket.GraduationPaused.selector);
        m.graduate();
        vm.prank(guardian);
        factory.setGraduationPaused(false);
        m.graduate();
    }

    function test_graduate_mainnetPathNeedsARegisteredBook() public {
        graduator.setCanCreate(false);
        Market m = _createDefault();
        _fillToRule(m);
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();
        address kuruBook = makeAddr("kuru book");
        graduator.registerBook(address(m), kuruBook);
        m.graduate();
        assertEq(m.book(), kuruBook);
    }

    function test_graduate_revertsWithoutGraduator() public {
        HunchBookFactory f2 =
            new HunchBookFactory(address(usdc), address(marketImpl), guardian, feeRecipient, _caps(), COLLATERAL_CAP);
        vm.prank(guardian);
        f2.addTemplate(TEMPLATE, IResolver(address(resolver)), _rule());
        address v2 = f2.vault();
        vm.prank(creator);
        usdc.approve(v2, type(uint256).max);
        vm.prank(creator);
        Market m = Market(payable(f2.createMarket(TEMPLATE, abi.encode(_timeWindow()), Side.Yes, CREATOR_MIN)));
        for (uint256 i; i < 10; ++i) {
            vm.startPrank(users[i]);
            usdc.approve(f2.vault(), type(uint256).max);
            m.stake(i < 6 ? Side.Yes : Side.No, 60e6);
            vm.stopPrank();
        }
        vm.expectRevert(IMarket.BookNotReady.selector);
        m.graduate();
    }
}

contract MarketClaimTest is BaseTest {
    function test_claimTokens_paysEachStakerProRata() public {
        Market m = _graduated();
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 t = y + n;

        (uint256 cy, uint256 cn) = m.claimableTokens(users[0]);
        assertEq(cy, 50e6 * t / y);
        assertEq(cn, 0);
        vm.prank(users[0]);
        m.claimTokens();
        assertEq(_yes(m).balanceOf(users[0]), 50e6 * t / y);
        (cy,) = m.claimableTokens(users[0]);
        assertEq(cy, 0);

        vm.prank(users[0]);
        vm.expectRevert(IMarket.NothingToClaim.selector);
        m.claimTokens();
    }

    function test_claimTokens_lastClaimSweepsDustToFeeRecipient() public {
        Market m = _graduated();
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 t = y + n;
        address[] memory all = new address[](12);
        all[0] = creator;
        for (uint256 i; i < 10; ++i) {
            all[i + 1] = users[i];
        }
        all[11] = users[15]; // never staked: skipped
        m.claimTokensFor(all);

        uint256 sumYes;
        uint256 sumNo;
        for (uint256 i; i < 11; ++i) {
            sumYes += _yes(m).balanceOf(all[i]);
            sumNo += _no(m).balanceOf(all[i]);
        }
        assertLe(sumYes, t);
        assertLe(sumNo, t);
        assertEq(_yes(m).balanceOf(address(m)), 0);
        assertEq(_no(m).balanceOf(address(m)), 0);
        assertEq(_yes(m).balanceOf(feeRecipient), t - sumYes);
        assertEq(_no(m).balanceOf(feeRecipient), t - sumNo);
        assertLe(t - sumYes, 7); // at most one base unit per YES staker
        assertLe(t - sumNo, 4);
        // Repeating is a no-op.
        m.claimTokensFor(all);
        _assertSetsMatchSupply(m);
    }

    function test_claimTokens_stakerOnBothSidesGetsBoth() public {
        Market m = _createDefault();
        _stake(m, users[11], Side.Yes, 20e6);
        _stake(m, users[11], Side.No, 30e6);
        _fillToRule(m);
        m.graduate();
        (uint256 y, uint256 n,) = m.poolTotals();
        vm.prank(users[11]);
        m.claimTokens();
        assertEq(_yes(m).balanceOf(users[11]), 20e6 * (y + n) / y);
        assertEq(_no(m).balanceOf(users[11]), 30e6 * (y + n) / n);
    }

    function test_claimTokens_revertsBeforeGraduation() public {
        Market m = _createDefault();
        vm.prank(creator);
        vm.expectRevert(IMarket.NotGraduated.selector);
        m.claimTokens();
        address[] memory list = new address[](1);
        list[0] = creator;
        vm.expectRevert(IMarket.NotGraduated.selector);
        m.claimTokensFor(list);
    }

    function test_claimTokens_stillWorksAfterSettlementAndVoid() public {
        Market m = _graduated();
        _settle(m, Outcome.Yes);
        vm.prank(users[0]);
        m.claimTokens();
        assertGt(_yes(m).balanceOf(users[0]), 0);

        Market v = _graduated();
        vm.warp(v.window().settleDeadline + 1);
        v.voidIfExpired();
        vm.prank(users[6]);
        v.claimTokens();
        assertGt(_no(v).balanceOf(users[6]), 0);
    }
}
