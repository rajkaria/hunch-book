// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralVault} from "../../src/core/CollateralVault.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {Market} from "../../src/core/Market.sol";
import {OutcomeToken} from "../../src/core/OutcomeToken.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IResolver} from "../../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Phase, Side, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {MockGraduator} from "../mocks/MockGraduator.sol";
import {MockResolver} from "../mocks/MockResolver.sol";

/// Shared fixture: a full core deployment with v0 parameters (PROTOCOL.md §10.3, §12),
/// a mock resolver standing in for the source, and a mock graduator standing in for Kuru.
abstract contract BaseTest is Test {
    uint32 internal constant TEMPLATE = 1;
    uint256 internal constant POOL_CAP = 5000e6;
    uint256 internal constant WALLET_CAP = 1000e6;
    uint256 internal constant MIN_STAKE = 1e6;
    uint256 internal constant CREATOR_MIN = 5e6;
    uint256 internal constant COLLATERAL_CAP = 50_000e6;

    TestUSDC internal usdc;
    HunchBookFactory internal factory;
    CollateralVault internal vault;
    Market internal marketImpl;
    MockResolver internal resolver;
    MockGraduator internal graduator;

    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal creator = makeAddr("creator");
    address[] internal users;

    uint64 internal nonce;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(50_000_000);

        usdc = new TestUSDC();
        marketImpl = new Market();
        factory =
            new HunchBookFactory(address(usdc), address(marketImpl), guardian, feeRecipient, _caps(), COLLATERAL_CAP);
        vault = CollateralVault(factory.vault());
        resolver = new MockResolver();
        graduator = new MockGraduator();
        factory.setGraduator(address(graduator));

        vm.prank(guardian);
        factory.addTemplate(TEMPLATE, IResolver(address(resolver)), _rule());

        for (uint256 i; i < 16; ++i) {
            address u = makeAddr(string.concat("user", vm.toString(i)));
            users.push(u);
            _fund(u, WALLET_CAP * 2);
        }
        _fund(creator, WALLET_CAP * 10);
    }

    // ---- parameters ----

    function _caps() internal pure returns (MarketCaps memory) {
        return MarketCaps({
            poolCap: uint128(POOL_CAP),
            walletCap: uint128(WALLET_CAP),
            minStake: uint128(MIN_STAKE),
            creatorMinStake: uint128(CREATOR_MIN)
        });
    }

    function _rule() internal pure returns (GraduationRule memory) {
        return GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700});
    }

    function _timeWindow() internal returns (Window memory w) {
        ++nonce;
        w.blockClock = false;
        w.lock = uint64(block.timestamp + 1 days + nonce);
        w.close = uint64(block.timestamp + 2 days + nonce);
        w.settleDeadline = w.close + 7 days;
    }

    function _blockWindow() internal returns (Window memory w) {
        ++nonce;
        w.blockClock = true;
        w.lock = uint64(block.number + 10_000 + nonce);
        w.close = uint64(block.number + 40_000 + nonce);
        w.settleDeadline = uint64(block.timestamp + 40_000 + 7 days);
    }

    // ---- actions ----

    function _fund(address who, uint256 amount) internal {
        while (amount > 0) {
            uint256 m = amount > 10_000e6 ? 10_000e6 : amount;
            usdc.mint(who, m);
            amount -= m;
        }
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _create(Window memory w, Side side, uint256 amount) internal returns (Market m) {
        vm.prank(creator);
        m = Market(payable(factory.createMarket(TEMPLATE, abi.encode(w), side, amount)));
    }

    function _createDefault() internal returns (Market) {
        return _create(_timeWindow(), Side.Yes, CREATOR_MIN);
    }

    function _stake(Market m, address who, Side side, uint256 amount) internal {
        vm.prank(who);
        m.stake(side, amount);
    }

    /// Fills a pool so the graduation rule holds: 11 stakers, 305 YES / 240 NO.
    function _fillToRule(Market m) internal {
        for (uint256 i; i < 6; ++i) {
            _stake(m, users[i], Side.Yes, 50e6);
        }
        for (uint256 i = 6; i < 10; ++i) {
            _stake(m, users[i], Side.No, 60e6);
        }
    }

    function _graduated() internal returns (Market m) {
        m = _createDefault();
        _fillToRule(m);
        m.graduate();
    }

    function _toClose(Market m) internal {
        Window memory w = m.window();
        if (w.blockClock) vm.roll(w.close);
        else vm.warp(w.close);
    }

    function _settle(Market m, Outcome o) internal {
        _toClose(m);
        resolver.setAnswer(o);
        m.settle("");
    }

    function _yes(Market m) internal view returns (OutcomeToken) {
        (address y,) = m.tokens();
        return OutcomeToken(y);
    }

    function _no(Market m) internal view returns (OutcomeToken) {
        (, address n) = m.tokens();
        return OutcomeToken(n);
    }

    function _assertSolvent() internal view {
        assertGe(vault.surplus(), 0, "vault insolvent");
        assertGe(usdc.balanceOf(address(vault)), vault.totalObligations(), "balance < obligations");
    }

    function _assertSetsMatchSupply(Market m) internal view {
        uint256 sets = vault.ledger(address(m)).sets;
        assertEq(_yes(m).totalSupply(), sets, "YES supply != sets");
        assertEq(_no(m).totalSupply(), sets, "NO supply != sets");
    }

    function _phase(Market m) internal view returns (Phase) {
        return m.phase();
    }
}
