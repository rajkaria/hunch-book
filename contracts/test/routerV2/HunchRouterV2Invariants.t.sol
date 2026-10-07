// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HunchRouterV2} from "../../src/core/HunchRouterV2.sol";
import {MockKuruAccountCoreV2, MockKuruSpotOrderBookV2} from "../mocks/MockKuruV2.sol";
import {MockTokenForRouter, MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";
import {MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {HunchRouterV2Base} from "./HunchRouterV2Base.sol";

/// Random sequences of the four trades (and book refills) by several traders. Calls that revert are
/// fine (thin book, slippage); what must hold after every call is checked by the invariants.
contract RouterV2Handler is Test {
    HunchRouterV2 internal router;
    MockKuruSpotOrderBookV2 internal book;
    MockKuruAccountCoreV2 internal core;
    MockVaultForRouter internal vault;
    MockMarketForRouter internal market;
    MockTokenForRouter internal usdc;
    MockTokenForRouter internal yes;
    MockTokenForRouter internal no;
    uint40 internal makerId;
    address internal maker;
    address[3] internal traders;

    uint256 public trades;

    constructor(
        HunchRouterV2 router_,
        MockKuruSpotOrderBookV2 book_,
        MockKuruAccountCoreV2 core_,
        MockVaultForRouter vault_,
        MockMarketForRouter market_,
        MockTokenForRouter[3] memory tokens,
        uint40 makerId_,
        address maker_
    ) {
        router = router_;
        book = book_;
        core = core_;
        vault = vault_;
        market = market_;
        (usdc, yes, no) = (tokens[0], tokens[1], tokens[2]);
        makerId = makerId_;
        maker = maker_;
        traders = [makeAddr("t0"), makeAddr("t1"), makeAddr("t2")];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(traders[i]);
            usdc.approve(address(router), type(uint256).max);
            yes.approve(address(router), type(uint256).max);
            no.approve(address(router), type(uint256).max);
            usdc.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function refill(uint256 seed) external {
        book.clear();
        uint256 mid = 50_000 + seed % 900_000;
        mid -= mid % 1000;
        for (uint256 i; i < 4; ++i) {
            uint256 size = 1e6 + uint256(keccak256(abi.encode(seed, i))) % 400e6;
            uint32 ask = uint32(mid + 1000 * (i + 1));
            uint32 bid = uint32(mid - 1000 * (i + 1) > 0 ? mid - 1000 * (i + 1) : 1000);
            _fund(yes, size);
            // forge-lint: disable-next-line(unsafe-typecast)
            book.addAsk(ask, uint96(size));
            _fund(usdc, (uint256(bid) * size + 1e6 - 1) / 1e6);
            // forge-lint: disable-next-line(unsafe-typecast)
            book.addBid(bid, uint96(size));
        }
    }

    function buyYes(uint256 who, uint256 amount) external {
        address t = traders[who % 3];
        amount = bound(amount, 1, 500e6);
        usdc.mint(t, amount);
        vm.prank(t);
        try router.buyYes(address(market), amount, 0, block.timestamp) {
            ++trades;
        } catch {}
    }

    function sellYes(uint256 who, uint256 amount) external {
        address t = traders[who % 3];
        amount = bound(amount, 1, 500e6);
        yes.mint(t, amount);
        vm.prank(t);
        try router.sellYes(address(market), amount, 0, block.timestamp) {
            ++trades;
        } catch {}
    }

    function buyNo(uint256 who, uint256 amount) external {
        address t = traders[who % 3];
        amount = bound(amount, 1, 500e6);
        usdc.mint(t, amount);
        vm.prank(t);
        try router.buyNo(address(market), amount, amount, block.timestamp) {
            ++trades;
        } catch {}
    }

    function sellNo(uint256 who, uint256 amount) external {
        address t = traders[who % 3];
        amount = bound(amount, 1, 500e6);
        usdc.mint(t, amount);
        vm.startPrank(t);
        vault.mintSets(address(market), amount, t);
        try router.sellNo(address(market), amount, 0, block.timestamp) {
            ++trades;
        } catch {}
        vm.stopPrank();
    }

    function _fund(MockTokenForRouter token, uint256 amount) internal {
        token.mint(maker, amount);
        vm.startPrank(maker);
        token.approve(address(core), amount);
        core.deposit(makerId, address(token), amount);
        vm.stopPrank();
    }
}

contract HunchRouterV2InvariantTest is HunchRouterV2Base {
    RouterV2Handler internal handler;
    int256 internal surplus0;

    function setUp() public override {
        super.setUp();
        handler = new RouterV2Handler(router, book, core, vault, market, [usdc, yes, no], makerId, maker);
        handler.refill(1);
        surplus0 = vault.surplus();
        targetContract(address(handler));
    }

    /// The sequences really trade (most calls succeed against the refilled book).
    function afterInvariant() public view {
        assertGt(handler.trades(), 0, "no trade went through");
    }

    /// The router and its Kuru account hold nothing between calls and keep no approvals.
    function invariant_routerHoldsNothing() public view {
        _assertRouterClean();
    }

    /// Flash loans are always repaid: the vault's surplus never moves.
    function invariant_vaultSurplusUnchanged() public view {
        assertEq(vault.surplus(), surplus0);
    }

    /// Every NO in existence is backed by a set the vault minted (none created or lost by the router).
    function invariant_setsMatchSupply() public view {
        assertEq(no.totalSupply(), vault.sets(address(market)));
    }
}
