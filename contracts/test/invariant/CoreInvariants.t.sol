// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "../core/Base.t.sol";
import {Borrower} from "../core/Vault.t.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {ICollateralVault} from "../../src/interfaces/ICollateralVault.sol";
import {MarketCaps, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

/// Drives random sequences of every user action across several markets. Every action checks its
/// own preconditions, so a revert inside the handler is a bug (fail_on_revert = true).
contract Handler is Test {
    CollateralVault internal vault;
    HunchBookFactory internal factory;
    TestUSDC internal usdc;
    MockResolver internal resolver;
    Borrower internal borrower;
    address internal feeRecipient;
    address internal creator;

    Market[] public markets;
    address[] public actors;
    mapping(address market => bool) public settledByHandler;

    uint256 public calls;
    // Successful actions, to show the random runs reach every path.
    uint256 public graduations;
    uint256 public settlements;
    uint256 public voids;
    uint256 public redemptions;
    uint256 public poolClaims;
    uint256 public merges;
    uint256 public mints;
    uint256 public flashLoans;

    constructor(
        CollateralVault v,
        HunchBookFactory f,
        TestUSDC u,
        MockResolver r,
        Market[] memory ms,
        address[] memory as_,
        address fr,
        address c
    ) {
        vault = v;
        factory = f;
        usdc = u;
        resolver = r;
        feeRecipient = fr;
        creator = c;
        for (uint256 i; i < ms.length; ++i) {
            markets.push(ms[i]);
        }
        for (uint256 i; i < as_.length; ++i) {
            actors.push(as_[i]);
        }
        borrower = new Borrower(v, u);
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _m(uint256 seed) internal view returns (Market) {
        return markets[seed % markets.length];
    }

    function _a(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ---- actions ----

    function stake(uint256 as_, uint256 ms, bool yes, uint256 amount) external {
        ++calls;
        Market m = _m(ms);
        address a = _a(as_);
        if (m.phase() != Phase.Pool) return;
        MarketCaps memory c = m.caps();
        (uint256 y, uint256 n,) = m.poolTotals();
        (uint256 py, uint256 pn) = m.stakeOf(a);
        uint256 room = _min(c.walletCap - (py + pn), c.poolCap - (y + n));
        room = _min(room, vault.collateralCap() - vault.totalCollateral());
        room = _min(room, usdc.balanceOf(a));
        if (room < c.minStake) return;
        amount = bound(amount, c.minStake, room);
        vm.prank(a);
        m.stake(yes ? Side.Yes : Side.No, amount);
    }

    function graduate(uint256 ms) external {
        ++calls;
        Market m = _m(ms);
        if (m.phase() != Phase.Pool || !m.graduationRuleMet()) return;
        m.graduate();
        ++graduations;
    }

    function claimTokens(uint256 as_, uint256 ms) external {
        ++calls;
        Market m = _m(ms);
        address a = _a(as_);
        if (!m.graduated()) return;
        (uint256 y, uint256 n) = m.claimableTokens(a);
        if (y == 0 && n == 0) return;
        vm.prank(a);
        m.claimTokens();
    }

    function mint(uint256 as_, uint256 ms, uint256 amount) external {
        ++calls;
        Market m = _m(ms);
        address a = _a(as_);
        if (m.phase() != Phase.Graduated) return;
        uint256 room = _min(usdc.balanceOf(a), vault.collateralCap() - vault.totalCollateral());
        if (room == 0) return;
        amount = bound(amount, 1, room);
        vm.prank(a);
        vault.mintSets(address(m), amount, a);
        ++mints;
    }

    function merge(uint256 as_, uint256 ms, uint256 amount) external {
        ++calls;
        Market m = _m(ms);
        address a = _a(as_);
        ICollateralVault.Ledger memory l = vault.ledger(address(m));
        bool ok = l.status == ICollateralVault.Status.Voided
            || (l.status == ICollateralVault.Status.Open && (m.phase() == Phase.Graduated || m.phase() == Phase.Closed));
        if (!ok || l.yes == address(0)) return;
        uint256 have = _min(OutcomeToken(l.yes).balanceOf(a), OutcomeToken(l.no).balanceOf(a));
        if (have == 0) return;
        amount = bound(amount, 1, have);
        vm.prank(a);
        vault.mergeSets(address(m), amount, a);
        ++merges;
    }

    function settle(uint256 ms, bool yes) external {
        ++calls;
        Market m = _m(ms);
        Phase p = m.phase();
        if (p == Phase.Settled || p == Phase.Voided) return;
        Window memory w = m.window();
        bool closed = w.blockClock ? block.number >= w.close : block.timestamp >= w.close;
        if (!closed || block.timestamp > w.settleDeadline) return;
        resolver.setAnswer(yes ? Outcome.Yes : Outcome.No);
        m.settle("");
        settledByHandler[address(m)] = true;
        ++settlements;
    }

    function voidMarket(uint256 ms) external {
        ++calls;
        Market m = _m(ms);
        Phase p = m.phase();
        if (p == Phase.Settled || p == Phase.Voided) return;
        if (block.timestamp <= m.window().settleDeadline) return;
        m.voidIfExpired();
        ++voids;
    }

    function redeem(uint256 as_, uint256 ms, bool yes, uint256 amount) external {
        ++calls;
        Market m = _m(ms);
        address a = _a(as_);
        ICollateralVault.Ledger memory l = vault.ledger(address(m));
        Side side = yes ? Side.Yes : Side.No;
        if (l.status == ICollateralVault.Status.Settled) {
            side = l.outcome == Outcome.Yes ? Side.Yes : Side.No;
        } else if (l.status != ICollateralVault.Status.Voided) {
            return;
        }
        uint256 bal = OutcomeToken(side == Side.Yes ? l.yes : l.no).balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        vault.redeem(address(m), side, amount, a);
        ++redemptions;
    }

    function claimPool(uint256 as_, uint256 ms) external {
        ++calls;
        Market m = _m(ms);
        address a = _a(as_);
        (uint256 paid,) = m.claimablePool(a);
        if (paid == 0) return;
        vm.prank(a);
        m.claimPool();
        ++poolClaims;
    }

    function flashRoundTrip(uint256 ms, uint256 amount, bool viaSets) external {
        ++calls;
        uint256 bal = usdc.balanceOf(address(vault));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        Market m = _m(ms);
        if (viaSets) {
            if (m.phase() != Phase.Graduated) return;
            if (vault.totalCollateral() + amount > vault.collateralCap()) return;
            borrower.set(Borrower.Mode.MintMergeRepay, address(m));
        } else {
            borrower.set(Borrower.Mode.Repay, address(0));
        }
        borrower.borrow(amount);
        ++flashLoans;
    }

    function withdrawFees(bool protocol) external {
        ++calls;
        if (protocol) {
            vm.prank(feeRecipient);
            vault.withdrawProtocolFees(feeRecipient);
        } else {
            vm.prank(creator);
            vault.withdrawCreatorFees(creator);
        }
    }

    function passTime(uint256 secs) external {
        ++calls;
        secs = bound(secs, 1, 1 days);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs * 3);
    }

    function donate(uint256 amount) external {
        ++calls;
        amount = bound(amount, 1, 1000e6);
        usdc.mint(address(vault), amount);
    }
}

contract CoreInvariantsTest is BaseTest {
    Handler internal handler;
    Market[] internal ms;

    function setUp() public override {
        super.setUp();
        // Four markets, seeded in different stages so random runs start deep in the lifecycle:
        // a fresh pool, a graduated market, a block-clock pool that already meets the rule,
        // and a two-sided pool that will settle as a pool.
        ms.push(_create(_timeWindow(), Side.Yes, CREATOR_MIN));
        ms.push(_graduated());
        Market ready = _create(_blockWindow(), Side.Yes, 8e6);
        _fillToRule(ready);
        ms.push(ready);
        Market pool = _create(_timeWindow(), Side.No, 20e6);
        _stake(pool, users[10], Side.Yes, 30e6);
        _stake(pool, users[11], Side.No, 15e6);
        ms.push(pool);

        address[] memory actors = new address[](12);
        for (uint256 i; i < 12; ++i) {
            actors[i] = users[i];
        }
        handler = new Handler(vault, factory, usdc, resolver, ms, actors, feeRecipient, creator);

        targetContract(address(handler));
        excludeSender(address(vault));
        excludeSender(address(factory));
    }

    /// The handler's paths all execute (none of them silently returns early forever).
    function test_handlerReachesEveryPath() public {
        handler.graduate(2); // the block-clock market meets the rule
        handler.claimTokens(0, 1);
        handler.claimTokens(0, 2);
        handler.mint(3, 1, 50e6);
        handler.merge(3, 1, 20e6);
        handler.flashRoundTrip(1, 100e6, true);
        handler.flashRoundTrip(0, 100e6, false);
        for (uint256 i; i < 3; ++i) {
            handler.passTime(1 days); // past close of every market
        }
        handler.settle(1, true); // graduated, time clock
        handler.settle(3, false); // pool-only
        handler.redeem(0, 1, true, type(uint256).max);
        handler.claimPool(11, 3);
        for (uint256 i; i < 8; ++i) {
            handler.passTime(1 days); // past every settlement deadline
        }
        handler.voidMarket(0);
        handler.voidMarket(2);
        handler.claimPool(0, 0);
        handler.redeem(0, 2, true, type(uint256).max);
        handler.withdrawFees(true);
        handler.withdrawFees(false);

        assertEq(handler.graduations(), 1, "graduate");
        assertEq(handler.settlements(), 2, "settle");
        assertEq(handler.voids(), 2, "void");
        assertEq(handler.redemptions(), 2, "redeem");
        assertGe(handler.poolClaims(), 1, "claimPool");
        assertEq(handler.mints(), 1, "mint");
        assertEq(handler.merges(), 1, "merge");
        assertEq(handler.flashLoans(), 2, "flash");
        invariant_solvent();
        invariant_obligationsAddUp();
        invariant_setsMatchSupply();
        invariant_poolLedger();
    }

    /// 1. The vault can always pay everything it owes.
    function invariant_solvent() public view {
        assertGe(vault.surplus(), 0);
        assertGe(usdc.balanceOf(address(vault)), vault.totalObligations());
    }

    /// The running totals equal the sum of the per-market ledgers plus the fee balances.
    function invariant_obligationsAddUp() public view {
        uint256 collateral;
        for (uint256 i; i < ms.length; ++i) {
            ICollateralVault.Ledger memory l = vault.ledger(address(ms[i]));
            collateral += uint256(l.pool) + l.sets;
        }
        assertEq(vault.totalCollateral(), collateral, "totalCollateral");
        assertEq(
            vault.totalObligations(), collateral + vault.protocolFees() + vault.creatorFees(creator), "obligations"
        );
    }

    /// 2. Before settlement YES supply = NO supply = sets. After it, the winning supply is exactly
    /// what is still owed; after a void, half of everything outstanding is covered.
    function invariant_setsMatchSupply() public view {
        for (uint256 i; i < ms.length; ++i) {
            ICollateralVault.Ledger memory l = vault.ledger(address(ms[i]));
            uint256 ys = OutcomeToken(l.yes).totalSupply();
            uint256 ns = OutcomeToken(l.no).totalSupply();
            if (l.status == ICollateralVault.Status.Open) {
                assertEq(ys, l.sets, "YES supply");
                assertEq(ns, l.sets, "NO supply");
            } else if (l.status == ICollateralVault.Status.Settled) {
                assertEq(l.outcome == Outcome.Yes ? ys : ns, l.sets, "winning supply");
            } else {
                assertGe(2 * uint256(l.sets), ys + ns, "void coverage");
            }
        }
    }

    /// 3. A pool's ledger equals its stakes until it settles; payouts never exceed it.
    function invariant_poolLedger() public view {
        for (uint256 i; i < ms.length; ++i) {
            Market m = ms[i];
            ICollateralVault.Ledger memory l = vault.ledger(address(m));
            (uint256 y, uint256 n,) = m.poolTotals();
            if (m.graduated()) {
                assertEq(l.pool, 0, "graduated pool not empty");
            } else if (l.status == ICollateralVault.Status.Open) {
                assertEq(l.pool, y + n, "pool != stakes");
            } else {
                assertLe(l.pool, y + n, "pool grew after settlement");
            }
        }
    }

    /// Claims never exceed what graduation minted: the market's own token balance never goes negative,
    /// so Σ claims <= T on each side.
    function invariant_claimsBounded() public view {
        for (uint256 i; i < ms.length; ++i) {
            Market m = ms[i];
            if (!m.graduated()) continue;
            (uint256 y, uint256 n,) = m.poolTotals();
            assertLe(_yes(m).balanceOf(address(m)), y + n);
            assertLe(_no(m).balanceOf(address(m)), y + n);
        }
    }

    /// 5. Only a resolver answer sets an outcome.
    function invariant_outcomesOnlyFromSettle() public view {
        for (uint256 i; i < ms.length; ++i) {
            if (!handler.settledByHandler(address(ms[i]))) {
                assertEq(uint8(ms[i].outcome()), uint8(Outcome.Unresolved));
            }
        }
    }

    function afterInvariant() public {
        emit log_named_uint("graduations", handler.graduations());
        emit log_named_uint("settlements", handler.settlements());
        emit log_named_uint("voids", handler.voids());
        emit log_named_uint("redemptions", handler.redemptions());
        emit log_named_uint("pool claims", handler.poolClaims());
        emit log_named_uint("mints", handler.mints());
        emit log_named_uint("merges", handler.merges());
        emit log_named_uint("flash loans", handler.flashLoans());
    }
}
