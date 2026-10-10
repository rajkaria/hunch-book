// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Market} from "../../src/core/Market.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {HunchMarginAccount} from "../../src/venue/HunchMarginAccount.sol";
import {HunchOrderBook} from "../../src/venue/HunchOrderBook.sol";
import {HunchOrderBookFactory} from "../../src/venue/HunchOrderBookFactory.sol";
import {VenueBase} from "./VenueBase.sol";

/// Who can create a Hunch book, with which parameters, and what the margin account lets each party do.
contract HunchOrderBookFactoryTest is VenueBase {
    Market internal m;
    address internal yes;

    function setUp() public override {
        super.setUp();
        m = _pool();
        yes = address(_yes(m));
    }

    function _deploy(
        address base,
        address quote,
        uint96 sP,
        uint32 pP,
        uint32 tick,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFee,
        uint256 makerFee,
        uint96 spread
    ) internal returns (address) {
        return venue.deployProxy(0, base, quote, sP, pP, tick, minSize, maxSize, takerFee, makerFee, spread);
    }

    function _ok() internal returns (address) {
        return _deploy(yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
    }

    // ---------------------------------------------------------------- creation

    function test_AnyoneCreatesAtThePredictedAddress() public {
        address predicted =
            venue.computeAddress(yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30, address(0), false);
        vm.prank(makeAddr("stranger"));
        address book = _ok();
        assertEq(book, predicted);
        assertTrue(margin.verifiedMarket(book));
        assertEq(HunchOrderBook(book).market(), address(m));
        assertEq(venue.bookCount(), 1);
        // old = true predicts with the given implementation instead.
        assertTrue(
            venue.computeAddress(yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30, address(1), true)
                != predicted
        );
    }

    function test_SameParametersTwiceReverts() public {
        _ok();
        vm.expectRevert();
        _ok();
        // Different parameters make a different book for the same market.
        address other = _deploy(yes, address(usdc), 1e6, 1e6, 10_000, MIN_SIZE, 5000e6, 0, 0, 30);
        assertTrue(margin.verifiedMarket(other));
    }

    function test_OnlyHunchYesTokens() public {
        TestUSDC stranger = new TestUSDC();
        vm.expectRevert(HunchOrderBookFactory.NotHunchMarket.selector);
        _deploy(address(stranger), address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
        // The NO token is a Hunch token, but books trade YES only.
        address noToken = address(_no(m));
        vm.expectRevert(HunchOrderBookFactory.NotHunchMarket.selector);
        _deploy(noToken, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.NotHunchMarket.selector);
        _deploy(makeAddr("eoa"), address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
    }

    function test_ParameterChecks() public {
        TestUSDC otherQuote = new TestUSDC();
        vm.expectRevert(HunchOrderBookFactory.WrongQuoteAsset.selector);
        _deploy(yes, address(otherQuote), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.InvalidSizePrecision.selector);
        _deploy(yes, address(usdc), 1e5, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.InvalidPricePrecision.selector);
        _deploy(yes, address(usdc), 1e6, 1e8, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.InvalidTickSize.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, 0, MIN_SIZE, 5000e6, 0, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.InvalidTickSize.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, 3000, MIN_SIZE, 5000e6, 0, 0, 30); // does not divide 1e6
        vm.expectRevert(HunchOrderBookFactory.InvalidTickSize.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, 200, MIN_SIZE, 5000e6, 0, 0, 30); // 5000 levels
        vm.expectRevert(HunchOrderBookFactory.MarketSizeError.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, TICK, 0, 5000e6, 0, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.MarketSizeError.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, TICK, 5000e6, 5000e6, 0, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.MarketFeeError.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 10, 0, 30);
        vm.expectRevert(HunchOrderBookFactory.MarketFeeError.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 10, 30);
        vm.expectRevert(HunchOrderBookFactory.InvalidSpread.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 35);
        vm.expectRevert(HunchOrderBookFactory.InvalidSpread.selector);
        _deploy(yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 500);
        vm.expectRevert(HunchOrderBookFactory.MarketTypeMismatch.selector);
        venue.deployProxy(1, yes, address(usdc), 1e6, 1e6, TICK, MIN_SIZE, 5000e6, 0, 0, 30);
    }

    function test_ConstructorChecks() public {
        vm.expectRevert(HunchOrderBookFactory.ZeroAddressNotAllowed.selector);
        new HunchOrderBookFactory(IHunchBookFactory(address(0)));
        vm.expectRevert(HunchMarginAccount.ZeroAddressNotAllowed.selector);
        new HunchMarginAccount(address(0));
    }

    // ---------------------------------------------------------------- margin account

    function test_DepositWithdrawAndBatchWithdraw() public {
        vm.startPrank(maker);
        margin.deposit(maker, address(usdc), 10e6);
        assertEq(margin.getBalance(maker, address(usdc)), 10e6);
        assertEq(margin.tracked(address(usdc)), 10e6);
        margin.withdraw(4e6, address(usdc));
        assertEq(margin.getBalance(maker, address(usdc)), 6e6);
        vm.expectRevert(HunchMarginAccount.InsufficientBalance.selector);
        margin.withdraw(7e6, address(usdc));
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = yes; // nothing there: skipped
        margin.batchWithdrawMaxTokens(tokens);
        vm.stopPrank();
        assertEq(margin.getBalance(maker, address(usdc)), 0);
        assertEq(margin.tracked(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(margin)), 0);
    }

    function test_DepositForSomeoneElse() public {
        vm.prank(maker);
        margin.deposit(taker, address(usdc), 3e6);
        assertEq(margin.getBalance(taker, address(usdc)), 3e6);
        assertEq(margin.getBalance(maker, address(usdc)), 0);
    }

    function test_DepositRejectsNativeAndZero() public {
        vm.deal(maker, 1 ether);
        vm.startPrank(maker);
        vm.expectRevert(HunchMarginAccount.NativeAssetMismatch.selector);
        margin.deposit{value: 1}(maker, address(usdc), 1e6);
        vm.expectRevert(HunchMarginAccount.ZeroAddressNotAllowed.selector);
        margin.deposit(address(0), address(usdc), 1e6);
        vm.stopPrank();
    }

    function test_OnlyBooksMoveEscrow() public {
        vm.startPrank(maker);
        vm.expectRevert(HunchMarginAccount.OnlyVerifiedMarketsAllowed.selector);
        margin.lock(maker, address(usdc), 1);
        vm.expectRevert(HunchMarginAccount.OnlyVerifiedMarketsAllowed.selector);
        margin.release(maker, address(usdc), 1);
        vm.expectRevert(HunchMarginAccount.OnlyVerifiedMarketsAllowed.selector);
        margin.escrowIn(address(usdc), 1);
        vm.expectRevert(HunchMarginAccount.OnlyVerifiedMarketsAllowed.selector);
        margin.payOut(address(usdc), maker, 1);
        vm.expectRevert(HunchMarginAccount.OnlyFactory.selector);
        margin.registerBook(maker);
        vm.stopPrank();
    }

    function test_BooksCannotClaimTokensNobodySent() public {
        address book = _ok();
        // A donation is untracked; a book could claim it only right after sending it itself, which
        // HunchOrderBook always does. Without any untracked tokens, escrowIn reverts.
        vm.expectRevert(HunchMarginAccount.UntrackedTokensMissing.selector);
        vm.prank(book);
        margin.escrowIn(address(usdc), 1);
        // A book cannot spend another book's escrow or more than its own.
        vm.expectRevert(HunchMarginAccount.InsufficientBalance.selector);
        vm.prank(book);
        margin.payOut(address(usdc), maker, 1);
        vm.expectRevert(HunchMarginAccount.InsufficientBalance.selector);
        vm.prank(book);
        margin.lock(maker, address(usdc), 1);
    }
}
