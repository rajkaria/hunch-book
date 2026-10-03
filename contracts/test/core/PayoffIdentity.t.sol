// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {Market} from "../../src/core/Market.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, Outcome, Side} from "../../src/interfaces/IHunchBookTypes.sol";

/// PROTOCOL.md §5.3 and invariant 4: for random stake sets, a staker who holds graduated tokens to
/// settlement gets what the pool would have paid, within rounding dust, and the vault stays solvent.
contract PayoffIdentityTest is BaseTest {
    uint32 internal constant LOOSE = 7;

    function setUp() public override {
        super.setUp();
        vm.prank(guardian);
        factory.addTemplate(
            LOOSE,
            IResolver(address(resolver)),
            GraduationRule({minPool: 1, minStakers: 2, minChanceBps: 1, maxChanceBps: 9999})
        );
    }

    function testFuzz_graduationIsPayoffIdentical(uint256 seed, uint8 nYes, uint8 nNo, bool yesWins) public {
        nYes = uint8(bound(nYes, 0, 6)); // plus the creator on YES
        nNo = uint8(bound(nNo, 1, 6));

        uint256 creatorStake = bound(uint256(keccak256(abi.encode(seed, "c"))), CREATOR_MIN, 350e6);
        vm.prank(creator);
        Market m = Market(payable(factory.createMarket(LOOSE, abi.encode(_timeWindow()), Side.Yes, creatorStake)));

        address[] memory stakers = new address[](1 + nYes + nNo);
        uint256[] memory amounts = new uint256[](stakers.length);
        stakers[0] = creator;
        amounts[0] = creatorStake;
        for (uint256 i; i < nYes + nNo; ++i) {
            uint256 a = bound(uint256(keccak256(abi.encode(seed, i))), MIN_STAKE, 350e6);
            stakers[i + 1] = users[i];
            amounts[i + 1] = a;
            _stake(m, users[i], i < nYes ? Side.Yes : Side.No, a);
        }
        (uint256 y, uint256 n,) = m.poolTotals();
        m.graduate();
        m.claimTokensFor(stakers);
        _settle(m, yesWins ? Outcome.Yes : Outcome.No);

        (uint256 win, uint256 lose) = yesWins ? (y, n) : (n, y);
        for (uint256 i; i < stakers.length; ++i) {
            bool onYes = i <= nYes;
            if (onYes != yesWins) continue;
            vm.startPrank(stakers[i]);
            uint256 bal = yesWins ? _yes(m).balanceOf(stakers[i]) : _no(m).balanceOf(stakers[i]);
            uint256 paid = vault.redeem(address(m), yesWins ? Side.Yes : Side.No, bal, stakers[i]);
            vm.stopPrank();

            uint256 gross = amounts[i] * lose / win;
            uint256 poolPaid = amounts[i] + gross - (gross * 200 + 9999) / 10_000;
            assertApproxEqAbs(paid, poolPaid, 2, "token payout differs from pool payout");
        }
        _assertSolvent();
    }

    function testFuzz_poolPayoutsNeverExceedThePool(uint256 seed, uint8 nYes, uint8 nNo, bool yesWins) public {
        nYes = uint8(bound(nYes, 0, 6));
        nNo = uint8(bound(nNo, 0, 6));
        uint256 creatorStake = bound(uint256(keccak256(abi.encode(seed, "c"))), CREATOR_MIN, 350e6);
        vm.prank(creator);
        Market m = Market(payable(factory.createMarket(LOOSE, abi.encode(_timeWindow()), Side.Yes, creatorStake)));
        address[] memory stakers = new address[](1 + nYes + nNo);
        stakers[0] = creator;
        for (uint256 i; i < nYes + nNo; ++i) {
            stakers[i + 1] = users[i];
            _stake(
                m, users[i], i < nYes ? Side.Yes : Side.No, bound(uint256(keccak256(abi.encode(seed, i))), 1e6, 350e6)
            );
        }
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 balBefore = usdc.balanceOf(address(vault));
        _settle(m, yesWins ? Outcome.Yes : Outcome.No);
        m.claimPoolFor(stakers);

        uint256 paidOut = balBefore - usdc.balanceOf(address(vault));
        uint256 fees = vault.protocolFees() + vault.creatorFees(creator);
        assertLe(paidOut + fees, y + n, "paid more than the pool");
        assertEq(vault.ledger(address(m)).pool, 0, "pool not fully distributed");
        assertEq(paidOut + fees, y + n, "pool leaked");
        uint256 losing = yesWins ? n : y;
        uint256 winning = yesWins ? y : n;
        if (winning != 0) assertLe(fees, losing * 200 / 10_000 + 2 * stakers.length, "fee above 2% of losing side");
        _assertSolvent();
    }
}
