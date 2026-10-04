// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {Outcome, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {AutoRedeemer} from "../../src/periphery/AutoRedeemer.sol";
import {MockResolver} from "../mocks/MockResolver.sol";
import {PeripheryBase} from "./PeripheryBase.sol";

/// Random opt-ins, opt-outs, approvals, transfers, settlements, voids, keeper redemptions (single
/// and batched) and direct redemptions across two markets. Every action checks its own
/// preconditions, so a revert is a bug. The handler compares every keeper redemption with what the
/// holder could have redeemed alone and counts any difference as a violation.
contract AutoRedeemerHandler is Test {
    AutoRedeemer internal redeemer;
    CollateralVault internal vault;
    TestUSDC internal usdc;
    MockResolver internal resolver;
    Market[] internal markets;
    address[] internal actors;
    address internal keeper = makeAddr("keeper");

    uint256 public violations;
    uint256 public keeperRedemptions;
    uint256 public batchRedemptions;
    uint256 public directRedemptions;
    uint256 public settlements;
    uint256 public voids;

    constructor(
        AutoRedeemer r,
        CollateralVault v,
        TestUSDC u,
        MockResolver res,
        Market[] memory ms,
        address[] memory as_
    ) {
        redeemer = r;
        vault = v;
        usdc = u;
        resolver = res;
        for (uint256 i; i < ms.length; ++i) {
            markets.push(ms[i]);
        }
        for (uint256 i; i < as_.length; ++i) {
            actors.push(as_[i]);
        }
    }

    function _m(uint256 seed) internal view returns (Market) {
        return markets[seed % markets.length];
    }

    function _a(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(Market m, bool yes) internal view returns (OutcomeToken) {
        (address y, address n) = m.tokens();
        return OutcomeToken(yes ? y : n);
    }

    function _redeemable(Market m) internal view returns (bool) {
        ICollateralVault.Status s = vault.ledger(address(m)).status;
        return s == ICollateralVault.Status.Settled || s == ICollateralVault.Status.Voided;
    }

    // ---- holder actions ----

    function setOptIn(uint256 a, bool on) external {
        vm.prank(_a(a));
        redeemer.setOptIn(on);
    }

    function setMarketOptOut(uint256 a, uint256 ms, bool out) external {
        vm.prank(_a(a));
        redeemer.setMarketOptOut(address(_m(ms)), out);
    }

    function approve(uint256 a, uint256 ms, bool yes, uint256 amount) external {
        OutcomeToken t = _token(_m(ms), yes);
        amount = amount % 3 == 0 ? type(uint256).max : bound(amount, 0, 500e6);
        vm.prank(_a(a));
        t.approve(address(redeemer), amount);
    }

    function transfer(uint256 a, uint256 b, uint256 ms, bool yes, uint256 amount) external {
        OutcomeToken t = _token(_m(ms), yes);
        address from = _a(a);
        uint256 bal = t.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        t.transfer(_a(b), amount);
    }

    function redeemDirectly(uint256 a, uint256 ms, bool yes, uint256 amount) external {
        Market m = _m(ms);
        ICollateralVault.Ledger memory l = vault.ledger(address(m));
        Side side = yes ? Side.Yes : Side.No;
        if (l.status == ICollateralVault.Status.Settled) {
            side = l.outcome == Outcome.Yes ? Side.Yes : Side.No;
        } else if (l.status != ICollateralVault.Status.Voided) {
            return;
        }
        address who = _a(a);
        uint256 bal = _token(m, side == Side.Yes).balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(who);
        vault.redeem(address(m), side, amount, who);
        ++directRedemptions;
    }

    // ---- market lifecycle ----

    function resolve(uint256 ms, uint8 choice) external {
        Market m = _m(ms);
        if (_redeemable(m)) return;
        Window memory w = m.window();
        if (choice % 3 == 2 || block.timestamp > w.settleDeadline) {
            if (block.timestamp <= w.settleDeadline) vm.warp(uint256(w.settleDeadline) + 1);
            m.voidIfExpired();
            ++voids;
        } else {
            if (block.timestamp < w.close) vm.warp(w.close);
            resolver.setAnswer(choice % 3 == 0 ? Outcome.Yes : Outcome.No);
            m.settle("");
            ++settlements;
        }
    }

    // ---- keeper ----

    function redeemFor(uint256 ms, uint256 a) external {
        Market m = _m(ms);
        address holder = _a(a);
        if (!_redeemable(m) || !redeemer.isActive(holder, address(m))) return;
        (uint256 y, uint256 n, uint256 expected) = redeemer.redeemable(address(m), holder);
        if (y == 0 && n == 0) return;
        uint256 before = usdc.balanceOf(holder);
        vm.prank(keeper);
        uint256 paid = redeemer.redeemFor(address(m), holder);
        if (paid != expected || usdc.balanceOf(holder) - before != paid) ++violations;
        ++keeperRedemptions;
    }

    struct Batch {
        Market m;
        address[] holders;
        bool[] listed;
        uint256[] usdcBefore;
        uint256[] tokensBefore;
        uint256 expected;
    }

    function redeemManyFor(uint256 ms, uint256 s1, uint256 s2, uint256 s3) external {
        Market m = _m(ms);
        if (!_redeemable(m)) return;
        Batch memory b;
        b.m = m;
        b.holders = new address[](3);
        b.holders[0] = _a(s1);
        b.holders[1] = _a(s2);
        b.holders[2] = _a(s3);
        _snapshot(b);

        vm.prank(keeper);
        (uint256 paid,) = redeemer.redeemManyFor(address(m), b.holders);
        if (paid != b.expected) ++violations;
        if (_received(b) != paid) ++violations;
        ++batchRedemptions;
    }

    /// Balances before the batch, which actors are listed, and what each listed holder can redeem.
    function _snapshot(Batch memory b) internal view {
        uint256 n = actors.length;
        b.listed = new bool[](n);
        b.usdcBefore = new uint256[](n);
        b.tokensBefore = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            b.usdcBefore[i] = usdc.balanceOf(actors[i]);
            b.tokensBefore[i] = _tokensOf(b.m, actors[i]);
        }
        for (uint256 j; j < b.holders.length; ++j) {
            uint256 idx = _index(b.holders[j]);
            if (b.listed[idx]) continue; // a duplicate finds nothing left
            b.listed[idx] = true;
            (,, uint256 p) = redeemer.redeemable(address(b.m), b.holders[j]);
            b.expected += p;
        }
    }

    /// USDC every actor gained; counts a violation for anyone touched who was not a listed, active holder.
    function _received(Batch memory b) internal returns (uint256 received) {
        for (uint256 i; i < actors.length; ++i) {
            address who = actors[i];
            uint256 gained = usdc.balanceOf(who) - b.usdcBefore[i];
            received += gained;
            bool touched = gained != 0 || _tokensOf(b.m, who) != b.tokensBefore[i];
            if (touched && (!b.listed[i] || !redeemer.isActive(who, address(b.m)))) ++violations;
        }
    }

    function _tokensOf(Market m, address who) internal view returns (uint256) {
        return _token(m, true).balanceOf(who) + _token(m, false).balanceOf(who);
    }

    function _index(address who) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == who) return i;
        }
        revert("not an actor");
    }

    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
        vm.roll(block.number + 1);
    }
}

contract AutoRedeemerInvariantsTest is PeripheryBase {
    AutoRedeemer internal redeemer;
    AutoRedeemerHandler internal handler;
    Market[] internal ms;

    function setUp() public override {
        super.setUp();
        redeemer = new AutoRedeemer(IHunchBookFactory(address(factory)));
        address[] memory actors = new address[](6);
        for (uint256 i; i < 6; ++i) {
            actors[i] = makeAddr(string.concat("holder", vm.toString(i)));
        }
        for (uint256 k; k < 2; ++k) {
            (Market m,) = _graduatedWithBook();
            ms.push(m);
            for (uint256 i; i < 6; ++i) {
                _giveTokens(m, actors[i], Side.Yes, (i + 1) * 7e6 + k);
                _giveTokens(m, actors[i], Side.No, (6 - i) * 5e6 + 1);
            }
        }
        // Half the holders start opted in with open approvals, so random runs reach the keeper paths.
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(actors[i]);
            redeemer.setOptIn(true);
            for (uint256 k; k < 2; ++k) {
                _yes(ms[k]).approve(address(redeemer), type(uint256).max);
                _no(ms[k]).approve(address(redeemer), type(uint256).max);
            }
            vm.stopPrank();
        }
        handler = new AutoRedeemerHandler(redeemer, vault, usdc, resolver, ms, actors);
        targetContract(address(handler));
    }

    /// The handler's paths all execute.
    function test_handlerReachesEveryPath() public {
        handler.setMarketOptOut(1, 1, true);
        handler.approve(4, 0, true, 3);
        handler.transfer(0, 5, 0, true, 1e6);
        handler.resolve(0, 0); // market 0 settles YES
        handler.redeemFor(0, 0);
        handler.redeemManyFor(0, 1, 2, 1);
        handler.redeemDirectly(5, 0, true, 1e6);
        handler.resolve(1, 2); // market 1 voids
        handler.redeemManyFor(1, 0, 1, 2);
        handler.setOptIn(0, false);
        handler.passTime(1 days);
        assertEq(handler.keeperRedemptions(), 1);
        assertEq(handler.batchRedemptions(), 2);
        assertEq(handler.directRedemptions(), 1);
        assertEq(handler.settlements(), 1);
        assertEq(handler.voids(), 1);
        invariant_holdsNothing();
        invariant_paysOnlyOptedInHoldersExactly();
    }

    /// The redeemer never holds USDC or tokens between calls.
    function invariant_holdsNothing() public view {
        assertEq(usdc.balanceOf(address(redeemer)), 0);
        for (uint256 i; i < ms.length; ++i) {
            assertEq(_yes(ms[i]).balanceOf(address(redeemer)), 0);
            assertEq(_no(ms[i]).balanceOf(address(redeemer)), 0);
        }
    }

    /// Every keeper redemption paid exactly what the holder could redeem alone, only to opted-in
    /// holders that were listed, and the vault stayed solvent.
    function invariant_paysOnlyOptedInHoldersExactly() public view {
        assertEq(handler.violations(), 0);
        _assertSolvent();
    }

    function afterInvariant() public {
        emit log_named_uint("keeper redemptions", handler.keeperRedemptions());
        emit log_named_uint("batch redemptions", handler.batchRedemptions());
        emit log_named_uint("direct redemptions", handler.directRedemptions());
        emit log_named_uint("settlements", handler.settlements());
        emit log_named_uint("voids", handler.voids());
    }
}
