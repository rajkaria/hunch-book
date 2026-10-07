// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ICollateralVault} from "../interfaces/ICollateralVault.sol";
import {IFlashLoanReceiver} from "../interfaces/IFlashLoanReceiver.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {Phase} from "../interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../interfaces/IHunchRouter.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IKuruAccountCore, IKuruSpotOrderBook, KuruSwapResult} from "../interfaces/external/IKuruV2.sol";

/// @title HunchRouterV2
/// @notice Atomic YES and NO trades on a graduated market's Kuru v2 YES/USDC book (docs/PROTOCOL.md §5.4).
/// Same calls, events and errors as HunchRouter (v1), so apps and integrations only change the address.
/// NO trades through the YES book: buying NO mints complete sets and sells the YES; selling NO buys YES
/// and merges. A vault flash loan covers the gap, so the user only sends their net cost.
///
/// Kuru v2 keeps balances in AccountCore under account ids. This router owns one root account
/// (`accountId`, created at deploy) and uses it only inside a call: deposit what it trades, `swap`, then
/// withdraw everything the account holds of both tokens. The account and this contract start and end
/// every call with nothing in them (tokens someone else deposits into the account go to the next trader).
///
/// Every call: the market must be one the factory created and in phase `Graduated`; the deadline (unix
/// seconds, inclusive) must not have passed; amounts must be nonzero; slippage limits are checked on
/// this contract's balance changes, never on Kuru's return values alone. Approvals to AccountCore and the
/// vault are exact and reset to zero in the same call. The Graduator (v2) guarantees every book quotes
/// in USDC base units and sizes in YES base units, so amounts pass to Kuru unchanged.
///
/// Paths:
/// - buyYes / sellYes: one exact-in swap. What Kuru could not fill (or left as dust at a price level)
///   comes back to the caller.
/// - buyNo(k): mints k sets for k USDC and sells the k YES. v2 has no fill-or-kill: YES the bids could not
///   take goes to the caller with the k NO, and `maxUsdcIn` bounds what the caller pays either way.
/// - sellNo(k): v2 swaps are exact-in, so the router searches Kuru's own `estimateSwap` (for this router's
///   account, so its fee tier applies) for the least quote Q that buys at least k YES (`quoteSellNo`),
///   borrows Q, buys, merges k sets into k USDC, repays Q and pays the caller k - Q plus any quote Kuru
///   did not use. YES bought above k goes to the caller. Reverts `Slippage` if k YES would cost more than
///   k USDC (asks at or above 1 USDC) and `InsufficientLiquidity` if the asks cannot supply k YES.
///
/// Kuru can reject a trade on its side: book paused (`toggleSpotMarkets`), protocol paused, withdrawals
/// frozen, or the protocol-wide WithdrawalLimiter budget used up. Each reverts the whole call: nothing is
/// left behind in Kuru or here.
contract HunchRouterV2 is IHunchRouter, IFlashLoanReceiver {
    using SafeTransferLib for address;

    error ZeroAddress();
    error CollateralMismatch();
    error Reentrancy();
    error OnlyVault();
    error UnexpectedFlashLoan();
    error InsufficientLiquidity();
    error AmountTooLarge();

    bytes32 internal constant FLASH_LOAN_CALLBACK = keccak256("HunchBook.onFlashLoan");
    /// Upper bound on `estimateSwap` calls in one exact-out search. Interpolation steps alternate with
    /// halvings, so 2 * log2(amount) steps always finish; the cap only bounds gas, and the search still
    /// returns a quote that buys enough.
    uint256 internal constant MAX_SEARCH_STEPS = 96;

    IHunchBookFactory public immutable factory;
    ICollateralVault public immutable vault;
    address public immutable usdc;
    IKuruAccountCore public immutable accountCore;
    /// This router's Kuru root account.
    uint40 public immutable accountId;

    bool private transient _locked;
    /// keccak256(abi.encode(amount, data)) of the one flash loan this router has asked for; zero otherwise.
    bytes32 private transient _pendingLoan;
    /// USDC the caller paid inside a buyNo flash loan, read back after the loan.
    uint256 private transient _buyNoCost;

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(IHunchBookFactory factory_, IKuruAccountCore accountCore_) {
        if (address(factory_) == address(0) || address(accountCore_) == address(0)) revert ZeroAddress();
        address vault_ = factory_.vault();
        address usdc_ = factory_.usdc();
        if (vault_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        if (ICollateralVault(vault_).usdc() != usdc_) revert CollateralMismatch();
        factory = factory_;
        vault = ICollateralVault(vault_);
        usdc = usdc_;
        accountCore = accountCore_;
        accountId = accountCore_.ensureRootAccount(address(this));
    }

    // ---------------------------------------------------------------- trades

    /// @inheritdoc IHunchRouter
    /// @dev Unspent USDC (asks ran out, or dust) is returned. Reverts `InsufficientLiquidity` if nothing fills.
    function buyYes(address market, uint256 usdcIn, uint256 minYesOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 yesOut)
    {
        if (usdcIn == 0) revert ZeroAmount();
        (address book, address yes,) = _tradable(market, deadline);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 yesBefore = yes.balanceOf(address(this));

        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        _swap(book, usdc, yes, true, usdcIn, minYesOut);

        yesOut = yes.balanceOf(address(this)) - yesBefore;
        if (yesOut == 0) revert InsufficientLiquidity();
        if (yesOut < minYesOut) revert Slippage();
        uint256 refund = usdc.balanceOf(address(this)) - usdcBefore;

        yes.safeTransfer(msg.sender, yesOut);
        if (refund != 0) usdc.safeTransfer(msg.sender, refund);
        emit Trade(market, msg.sender, Kind.BuyYes, usdcIn - refund, yesOut, book);
    }

    /// @inheritdoc IHunchRouter
    /// @dev YES the bids could not absorb is returned. Reverts `InsufficientLiquidity` if nothing fills.
    function sellYes(address market, uint256 yesIn, uint256 minUsdcOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (yesIn == 0) revert ZeroAmount();
        (address book, address yes,) = _tradable(market, deadline);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 yesBefore = yes.balanceOf(address(this));

        yes.safeTransferFrom(msg.sender, address(this), yesIn);
        _swap(book, yes, usdc, false, yesIn, minUsdcOut);

        usdcOut = usdc.balanceOf(address(this)) - usdcBefore;
        if (usdcOut == 0) revert InsufficientLiquidity();
        if (usdcOut < minUsdcOut) revert Slippage();
        uint256 unsold = yes.balanceOf(address(this)) - yesBefore;

        usdc.safeTransfer(msg.sender, usdcOut);
        if (unsold != 0) yes.safeTransfer(msg.sender, unsold);
        emit Trade(market, msg.sender, Kind.SellYes, yesIn - unsold, usdcOut, book);
    }

    /// @inheritdoc IHunchRouter
    /// @dev Flash-borrows `noOut` USDC, mints `noOut` sets, sells the `noOut` YES, pulls
    /// `noOut - proceeds` from the caller (at most `maxUsdcIn`), repays, and sends exactly `noOut` NO plus
    /// any YES the bids did not take. The caller approves this router for USDC. Needs the vault to hold at
    /// least `noOut` USDC.
    function buyNo(address market, uint256 noOut, uint256 maxUsdcIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcPaid)
    {
        if (noOut == 0) revert ZeroAmount();
        (address book, address yes, address no) = _tradable(market, deadline);
        // USDC, YES and NO held before the loan (an array keeps the stack shallow).
        uint256[3] memory before =
            [usdc.balanceOf(address(this)), yes.balanceOf(address(this)), no.balanceOf(address(this))];

        _flashLoan(noOut, abi.encode(Kind.BuyNo, market, book, yes, msg.sender, noOut, maxUsdcIn));
        usdcPaid = _buyNoCost;
        _buyNoCost = 0;

        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (no.balanceOf(address(this)) - before[2] != noOut) revert UnexpectedFlashLoan();
        uint256 excess = usdc.balanceOf(address(this)) - before[0];
        uint256 unsold = yes.balanceOf(address(this)) - before[1];

        no.safeTransfer(msg.sender, noOut);
        if (excess != 0) usdc.safeTransfer(msg.sender, excess);
        if (unsold != 0) yes.safeTransfer(msg.sender, unsold);
        emit Trade(market, msg.sender, Kind.BuyNo, usdcPaid, noOut, book);
    }

    /// @inheritdoc IHunchRouter
    /// @dev Pulls `noIn` NO, flash-borrows Q = `quoteSellNo(market, noIn)` USDC, buys YES with it, merges
    /// `noIn` sets into `noIn` USDC, repays Q and pays the caller `noIn - Q` plus any USDC Kuru did not use.
    /// YES bought above `noIn` goes to the caller. The caller approves this router for NO.
    function sellNo(address market, uint256 noIn, uint256 minUsdcOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (noIn == 0) revert ZeroAmount();
        (address book, address yes, address no) = _tradable(market, deadline);
        uint256 quoteIn = _quoteForExactYes(book, noIn);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 yesBefore = yes.balanceOf(address(this));

        no.safeTransferFrom(msg.sender, address(this), noIn);
        _flashLoan(quoteIn, abi.encode(Kind.SellNo, market, book, yes, noIn));

        usdcOut = usdc.balanceOf(address(this)) - usdcBefore;
        if (usdcOut < minUsdcOut) revert Slippage();
        uint256 extraYes = yes.balanceOf(address(this)) - yesBefore;

        if (usdcOut != 0) usdc.safeTransfer(msg.sender, usdcOut);
        if (extraYes != 0) yes.safeTransfer(msg.sender, extraYes);
        emit Trade(market, msg.sender, Kind.SellNo, noIn, usdcOut, book);
    }

    // ---------------------------------------------------------------- flash loan

    /// @inheritdoc IFlashLoanReceiver
    /// @dev Only the vault, only for the loan this router requested in the current call (same amount
    /// and data), and only once. Anything else reverts `OnlyVault` or `UnexpectedFlashLoan`.
    function onFlashLoan(address initiator, uint256 amount, bytes calldata data) external returns (bytes32) {
        if (msg.sender != address(vault)) revert OnlyVault();
        bytes32 pending = _pendingLoan;
        if (initiator != address(this) || pending == bytes32(0) || keccak256(abi.encode(amount, data)) != pending) {
            revert UnexpectedFlashLoan();
        }
        _pendingLoan = bytes32(0);

        if (abi.decode(data[:32], (Kind)) == Kind.BuyNo) {
            _buyNoInLoan(amount, data);
        } else {
            _sellNoInLoan(amount, data);
        }
        usdc.safeApprove(address(vault), amount);
        return FLASH_LOAN_CALLBACK;
    }

    /// Inside the loan: this contract holds `amount` (= noOut) extra USDC.
    function _buyNoInLoan(uint256 amount, bytes calldata data) internal {
        (, address market, address book, address yes, address user, uint256 noOut, uint256 maxUsdcIn) =
            abi.decode(data, (Kind, address, address, address, address, uint256, uint256));
        uint256 usdcBase = usdc.balanceOf(address(this)) - amount;

        usdc.safeApprove(address(vault), noOut);
        vault.mintSets(market, noOut, address(this));
        usdc.safeApprove(address(vault), 0);

        _swap(book, yes, usdc, false, noOut, noOut > maxUsdcIn ? noOut - maxUsdcIn : 0);

        uint256 proceeds = usdc.balanceOf(address(this)) - usdcBase;
        uint256 cost = proceeds >= noOut ? 0 : noOut - proceeds;
        if (cost > maxUsdcIn) revert Slippage();
        // `user` is the buyNo caller: onFlashLoan only accepts the exact data buyNo encoded in this call.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        if (cost != 0) usdc.safeTransferFrom(user, address(this), cost);
        _buyNoCost = cost;
    }

    /// Inside the loan: this contract holds `amount` (= Q) extra USDC and the caller's `noIn` NO.
    function _sellNoInLoan(uint256 amount, bytes calldata data) internal {
        (, address market, address book, address yes, uint256 noIn) =
            abi.decode(data, (Kind, address, address, address, uint256));
        uint256 usdcBase = usdc.balanceOf(address(this)) - amount;
        uint256 yesBase = yes.balanceOf(address(this));

        _swap(book, usdc, yes, true, amount, noIn);
        if (yes.balanceOf(address(this)) - yesBase < noIn) revert Slippage();

        vault.mergeSets(market, noIn, address(this));
        // Repaying `amount` must leave at least what we started with: the caller never pays to sell.
        if (usdc.balanceOf(address(this)) < usdcBase + amount) revert Slippage();
    }

    function _flashLoan(uint256 amount, bytes memory data) internal {
        _pendingLoan = keccak256(abi.encode(amount, data));
        vault.flashLoan(address(this), amount, data);
        if (_pendingLoan != bytes32(0)) revert UnexpectedFlashLoan();
        usdc.safeApprove(address(vault), 0);
    }

    // ---------------------------------------------------------------- quotes

    /// USDC that `sellNo(market, noIn, ...)` would borrow and spend on YES right now: the least quote for
    /// which Kuru's `estimateSwap` credits at least `noIn` YES to this router's account. The caller would
    /// receive `noIn` minus it (plus any quote Kuru leaves unused). Reverts `InsufficientLiquidity` if the
    /// asks cannot supply `noIn` YES, `Slippage` if they would cost more than `noIn` USDC.
    function quoteSellNo(address market, uint256 noIn) external view returns (uint256) {
        if (noIn == 0) revert ZeroAmount();
        if (!factory.isMarket(market)) revert UnknownMarket();
        address book = IMarket(market).book();
        if (book == address(0)) revert NotTradable();
        return _quoteForExactYes(book, noIn);
    }

    /// Least q in (0, yesOut] with estimateSwap(buy, q).amountOut >= yesOut. Merging yesOut sets returns
    /// yesOut USDC, so a q above yesOut can never be repaid: the search stays at or below it.
    ///
    /// Invariant: f(lo) < yesOut <= f(hi), f = Kuru's estimate (non-decreasing in q). Steps alternate between
    /// linear interpolation (exact within one price level, where f is linear up to rounding) and halving,
    /// so the bracket shrinks geometrically even where f bends. Returns `hi`, which always buys enough.
    function _quoteForExactYes(address book, uint256 yesOut) internal view returns (uint256) {
        uint256 hi = yesOut;
        KuruSwapResult memory r = _estimateBuy(book, hi);
        if (r.amountOut < yesOut) {
            // Not enough YES for yesOut USDC: either the whole ask side holds too little, or it is too
            // expensive (at or above 1 USDC). Only this failing path pays to ask about the whole side.
            if (_estimateBuy(book, type(uint96).max).amountOut < yesOut) revert InsufficientLiquidity();
            revert Slippage();
        }
        uint256 fHi = r.amountOut;
        uint256 lo = 0;
        uint256 fLo = 0;

        for (uint256 step; step < MAX_SEARCH_STEPS && hi - lo > 1; ++step) {
            uint256 q = lo + (hi - lo) / 2;
            if (step % 2 == 0 && fHi > fLo) {
                // Interpolate between (lo, fLo) and (hi, fHi), rounding up, kept strictly inside.
                q = lo + _ceilDiv((hi - lo) * (yesOut - fLo), fHi - fLo);
                if (q <= lo) q = lo + 1;
                if (q >= hi) q = hi - 1;
            }
            uint256 f = _estimateBuy(book, q).amountOut;
            if (f >= yesOut) {
                hi = q;
                fHi = f;
            } else {
                lo = q;
                fLo = f;
            }
        }
        return hi;
    }

    function _estimateBuy(address book, uint256 quoteIn) internal view returns (KuruSwapResult memory) {
        return IKuruSpotOrderBook(book).estimateSwap(accountId, true, _toU128(quoteIn));
    }

    // ---------------------------------------------------------------- internals

    /// Checks shared by every trade; returns the market's book and tokens.
    function _tradable(address market, uint256 deadline) internal view returns (address book, address yes, address no) {
        if (block.timestamp > deadline) revert Expired();
        if (!factory.isMarket(market)) revert UnknownMarket();
        if (IMarket(market).phase() != Phase.Graduated) revert NotTradable();
        book = IMarket(market).book();
        if (book == address(0)) revert NotTradable();
        (yes, no) = IMarket(market).tokens();
    }

    /// Deposits `amountIn` of `tokenIn` into this router's Kuru account, swaps it on `book`, and withdraws
    /// everything the account then holds of both tokens back to this contract. Kuru reverts if it would
    /// credit less than `minOut` (callers check balance changes again).
    function _swap(address book, address tokenIn, address tokenOut, bool isBuy, uint256 amountIn, uint256 minOut)
        internal
    {
        uint128 amount = _toU128(amountIn);
        tokenIn.safeApprove(address(accountCore), amountIn);
        accountCore.deposit(accountId, tokenIn, amountIn);
        tokenIn.safeApprove(address(accountCore), 0);
        // Kuru's return value is ignored on purpose: callers measure balance changes instead. The
        // deadline was checked by `_tradable`; this call happens now.
        // forge-lint: disable-next-line(unused-return,unsafe-typecast)
        IKuruSpotOrderBook(book).swap(accountId, isBuy, amount, _toU128(minOut), uint64(block.timestamp));
        _withdrawAll(tokenOut);
        _withdrawAll(tokenIn);
    }

    function _withdrawAll(address token) internal {
        uint256 balance = accountCore.getBalance(accountId, token);
        if (balance != 0) accountCore.withdraw(accountId, token, balance, address(this));
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _toU128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert AmountTooLarge();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(x);
    }
}
