// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ICollateralVault} from "../interfaces/ICollateralVault.sol";
import {IFlashLoanReceiver} from "../interfaces/IFlashLoanReceiver.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {Phase} from "../interfaces/IHunchBookTypes.sol";
import {IHunchRouter} from "../interfaces/IHunchRouter.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IKuruOrderBook, KuruMarketParams} from "../interfaces/external/IKuruOrderBook.sol";

/// @title HunchRouter
/// @notice Atomic YES and NO trades on a graduated market's Kuru YES/USDC book (docs/PROTOCOL.md §5.4).
/// NO trades through the same book: buying NO mints complete sets and sells the YES; selling NO buys
/// YES and merges. A vault flash loan covers the gap, so the user only sends their net cost.
///
/// Every call: the market must be one the factory created and in phase `Graduated`; the deadline
/// (unix seconds, inclusive) must not have passed; amounts must be nonzero; slippage limits are
/// checked on this contract's balance changes, never on Kuru's return values alone. Approvals to the
/// book and to the vault are set to the exact amount and reset to zero in the same call. The router
/// starts and ends every call with the token balances it started with (zero in normal use): every
/// token Kuru returns, including refunds and unsold remainders, goes back to the caller.
///
/// Kuru is used on its wallet path (`isMargin` = false): the book pulls from this contract with
/// transferFrom and pays out by transfer. The Graduator guarantees that every Hunch book quotes in
/// USDC base units and sizes in YES base units (pricePrecision = 10^6 = sizePrecision for 6-decimal
/// tokens), so amounts pass to Kuru unchanged.
///
/// Rounding, per path (p = a book price in USDC base units per 1 YES, so 0.42 USDC is 420000;
/// f = the book's taker fee in bps; Kuru's own integer rounding, nothing added by the router):
/// - buyYes: at each ask level Kuru buys floor(quote * 1e6 / p) YES and recomputes the quote left as
///   floor(p * sizeLeft / 1e6). The truncated remainder (under 3 USDC base units per level touched,
///   for p <= 1e6) stays in Kuru's MarginAccount. YES out = filled - ceil(filled * f / 1e4). Quote left
///   when the asks run out is refunded by Kuru and forwarded to the caller.
/// - sellYes: each bid level pays floor(size * p / 1e6) USDC; USDC out = sum - ceil(sum * f / 1e4).
///   YES Kuru could not sell is refunded and forwarded to the caller.
/// - buyNo(k): mints k sets for exactly k USDC and sells the k YES fill-or-kill, so the caller gets
///   exactly k NO and pays exactly k - proceeds (proceeds as in sellYes). If proceeds exceed k (bids
///   above 1 USDC), the caller pays nothing and receives the excess.
/// - sellNo(k): Kuru market buys are quote-in, so the router reads the resting asks (`getL2Book`) and
///   computes the smallest quote Q for which Kuru's matching credits at least k YES after the fee (see
///   `quoteSellNo`). It borrows Q, buys, merges k sets into k USDC, repays Q and pays the caller
///   k - Q, plus the quote Kuru refunds when rounding carries the fill past the last resting ask
///   (a few base units at most). Q is minimal: Q - 1 would credit fewer than k YES. Integer rounding
///   can credit slightly more than k YES: the extra is at most 1 + the sum of ceil(1e6 / p) over the
///   ask levels the fill touches (2 units per level at 0.50, 1000 at 0.001). The extra YES goes to the
///   caller. If someone has deposited into the book's AMM vault (Hunch leaves it empty), the vault's
///   asks can change the fill; the router still requires at least k YES and reverts `Slippage` otherwise.
///
/// Slippage reverts can come from Kuru (`SlippageExceeded()`, `InsufficientLiquidity()`) when its own
/// minimum-out check fires first, or from this contract (`Slippage()`, `InsufficientLiquidity()`).
contract HunchRouter is IHunchRouter, IFlashLoanReceiver {
    using SafeTransferLib for address;

    error ZeroAddress();
    error CollateralMismatch();
    error Reentrancy();
    error OnlyVault();
    error UnexpectedFlashLoan();
    error InsufficientLiquidity();
    error AmountTooLarge();

    bytes32 internal constant FLASH_LOAN_CALLBACK = keccak256("HunchBook.onFlashLoan");
    uint256 internal constant BPS = 10_000;
    /// `sellNo` reads this many ask levels first, then `ASK_LEVELS_MORE`, then the whole ask side.
    uint32 internal constant ASK_LEVELS_FIRST = 16;
    uint32 internal constant ASK_LEVELS_MORE = 256;

    IHunchBookFactory public immutable factory;
    ICollateralVault public immutable vault;
    address public immutable usdc;

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

    constructor(IHunchBookFactory factory_) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        address vault_ = factory_.vault();
        address usdc_ = factory_.usdc();
        if (vault_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        if (ICollateralVault(vault_).usdc() != usdc_) revert CollateralMismatch();
        factory = factory_;
        vault = ICollateralVault(vault_);
        usdc = usdc_;
    }

    // ---------------------------------------------------------------- trades

    /// @inheritdoc IHunchRouter
    /// @dev Unspent USDC (asks ran out) is returned. Reverts `InsufficientLiquidity` if nothing fills.
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
        _marketBuy(book, usdcIn, minYesOut);

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
        _marketSell(book, yes, yesIn, minUsdcOut, false);

        usdcOut = usdc.balanceOf(address(this)) - usdcBefore;
        if (usdcOut == 0) revert InsufficientLiquidity();
        if (usdcOut < minUsdcOut) revert Slippage();
        uint256 unsold = yes.balanceOf(address(this)) - yesBefore;

        usdc.safeTransfer(msg.sender, usdcOut);
        if (unsold != 0) yes.safeTransfer(msg.sender, unsold);
        emit Trade(market, msg.sender, Kind.SellYes, yesIn - unsold, usdcOut, book);
    }

    /// @inheritdoc IHunchRouter
    /// @dev Flash-borrows `noOut` USDC, mints `noOut` sets, sells the `noOut` YES fill-or-kill, pulls
    /// `noOut - proceeds` from the caller (at most `maxUsdcIn`), repays, and sends exactly `noOut` NO.
    /// The caller approves this router for USDC. Needs the vault to hold at least `noOut` USDC.
    function buyNo(address market, uint256 noOut, uint256 maxUsdcIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcPaid)
    {
        if (noOut == 0) revert ZeroAmount();
        (address book, address yes, address no) = _tradable(market, deadline);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 noBefore = no.balanceOf(address(this));

        _flashLoan(noOut, abi.encode(Kind.BuyNo, market, book, yes, msg.sender, noOut, maxUsdcIn));
        usdcPaid = _buyNoCost;
        _buyNoCost = 0;

        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (no.balanceOf(address(this)) - noBefore != noOut) revert UnexpectedFlashLoan();
        uint256 excess = usdc.balanceOf(address(this)) - usdcBefore;

        no.safeTransfer(msg.sender, noOut);
        if (excess != 0) usdc.safeTransfer(msg.sender, excess);
        emit Trade(market, msg.sender, Kind.BuyNo, usdcPaid, noOut, book);
    }

    /// @inheritdoc IHunchRouter
    /// @dev Pulls `noIn` NO, flash-borrows Q = `quoteSellNo(market, noIn)` USDC, market-buys YES with
    /// it, merges `noIn` sets into `noIn` USDC, repays Q and pays the caller `noIn - Q` plus any USDC
    /// Kuru refunded. YES credited above `noIn` goes to the caller. The caller approves this router for NO.
    /// Reverts `Slippage` if buying the YES would cost more than the merge returns (asks above 1 USDC).
    function sellNo(address market, uint256 noIn, uint256 minUsdcOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (noIn == 0) revert ZeroAmount();
        (address book, address yes, address no) = _tradable(market, deadline);
        uint256 quoteIn = _quoteForExactBase(book, noIn);
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
        uint256 yesBase = yes.balanceOf(address(this));

        usdc.safeApprove(address(vault), noOut);
        vault.mintSets(market, noOut, address(this));
        usdc.safeApprove(address(vault), 0);

        _marketSell(book, yes, noOut, noOut > maxUsdcIn ? noOut - maxUsdcIn : 0, true);
        // Fill-or-kill: every minted YES must be gone.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (yes.balanceOf(address(this)) != yesBase) revert InsufficientLiquidity();

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

        _marketBuy(book, amount, noIn);
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

    /// USDC that `sellNo(market, noIn, ...)` would borrow and spend on YES right now, from the resting
    /// asks. The caller would receive `noIn - quoteSellNo(market, noIn)` USDC. Reverts
    /// `InsufficientLiquidity` if the asks cannot supply `noIn` YES after the taker fee.
    function quoteSellNo(address market, uint256 noIn) external view returns (uint256) {
        if (noIn == 0) revert ZeroAmount();
        if (!factory.isMarket(market)) revert UnknownMarket();
        address book = IMarket(market).book();
        if (book == address(0)) revert NotTradable();
        return _quoteForExactBase(book, noIn);
    }

    /// Smallest Kuru quote (USDC base units) whose market buy credits at least `baseOut` base units
    /// after the taker fee, against the book's resting asks.
    ///
    /// Kuru credits `gross - ceil(gross * f / 1e4)` = floor(gross * (1e4 - f) / 1e4), so the gross size
    /// needed is G = ceil(baseOut * 1e4 / (1e4 - f)). Kuru's quote-in matching at an ask level with price
    /// p and size s, given quote q: fillable F = floor(q * sP / p); if F <= s it fills F and stops; else it
    /// fills s and continues with q' = floor(p * (F - s) / sP). Let level k be the first where the
    /// cumulative size reaches G, and need = G - (size of levels before k). Working backwards:
    ///   Q_k = ceil(need * p_k / sP)
    ///   Q_i = ceil((s_i + ceil(Q_{i+1} * sP / p_i)) * p_i / sP)   for i = k-1 .. 1
    /// Each step is the least quote that reaches the next one, and Kuru's fill is monotone in q, so Q_1
    /// is the least quote that credits at least `baseOut`.
    function _quoteForExactBase(address book, uint256 baseOut) internal view returns (uint256) {
        KuruMarketParams memory p = _marketParams(book);
        uint256 sP = p.sizePrecision;
        uint256 gross = _ceilDiv(baseOut * BPS, BPS - p.takerFeeBps);

        uint32 levels = ASK_LEVELS_FIRST;
        while (true) {
            // At most three reads: 16 levels, 256 levels, then the whole ask side.
            // forge-lint: disable-next-line(calls-loop)
            bytes memory l2 = IKuruOrderBook(book).getL2Book(0, levels);
            (bool covered, uint256 quote, uint256 askLevels) = _quoteFromAsks(l2, gross, sP);
            if (covered) return quote;
            if (askLevels < levels || levels == type(uint32).max) revert InsufficientLiquidity();
            levels = levels == ASK_LEVELS_FIRST ? ASK_LEVELS_MORE : type(uint32).max;
        }
    }

    /// Parses Kuru's L2 encoding ([block] [bid price, size]... [0] [ask price, size]...) and applies the
    /// backward recurrence above. Returns whether the asks cover `gross`, the quote, and the number of
    /// ask levels read.
    function _quoteFromAsks(bytes memory l2, uint256 gross, uint256 sP)
        internal
        pure
        returns (bool covered, uint256 quote, uint256 askLevels)
    {
        uint256 words = l2.length / 32;
        uint256 i = 1; // word 0 is the block number
        while (i < words && _word(l2, i) != 0) {
            i += 2; // skip bid levels, if any were returned
        }
        uint256 asks = i + 1; // first ask price word
        askLevels = words > asks ? (words - asks) / 2 : 0;

        uint256 cumulative = 0;
        uint256 k = askLevels;
        for (uint256 j; j < askLevels; ++j) {
            cumulative += _word(l2, asks + 2 * j + 1);
            if (cumulative >= gross) {
                k = j;
                break;
            }
        }
        if (k == askLevels) return (false, 0, askLevels);

        uint256 price = _word(l2, asks + 2 * k);
        uint256 need = gross - (cumulative - _word(l2, asks + 2 * k + 1));
        if (price == 0) revert InsufficientLiquidity();
        quote = _ceilDiv(need * price, sP);
        while (k != 0) {
            --k;
            price = _word(l2, asks + 2 * k);
            if (price == 0) revert InsufficientLiquidity();
            uint256 fill = _word(l2, asks + 2 * k + 1) + _ceilDiv(quote * sP, price);
            quote = _ceilDiv(fill * price, sP);
        }
        covered = true;
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

    /// Kuru wallet-path market buy: exact approval, then reset.
    function _marketBuy(address book, uint256 quote, uint256 minBaseOut) internal {
        usdc.safeApprove(book, quote);
        // Kuru's return value is ignored on purpose: callers measure balance changes instead.
        // forge-lint: disable-next-line(unused-return)
        IKuruOrderBook(book).placeAndExecuteMarketBuy(_toU96(quote), minBaseOut, false, false);
        usdc.safeApprove(book, 0);
    }

    /// Kuru wallet-path market sell: exact approval, then reset.
    function _marketSell(address book, address yes, uint256 size, uint256 minQuoteOut, bool fillOrKill) internal {
        yes.safeApprove(book, size);
        // Kuru's return value is ignored on purpose: callers measure balance changes instead.
        // forge-lint: disable-next-line(unused-return)
        IKuruOrderBook(book).placeAndExecuteMarketSell(_toU96(size), minQuoteOut, false, fillOrKill);
        yes.safeApprove(book, 0);
    }

    function _marketParams(address book) internal view returns (KuruMarketParams memory) {
        (bool ok, bytes memory ret) = book.staticcall(abi.encodeCall(IKuruOrderBook.getMarketParams, ()));
        if (!ok || ret.length < 352) revert NotTradable();
        return abi.decode(ret, (KuruMarketParams));
    }

    function _word(bytes memory data, uint256 index) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), mul(index, 32)))
        }
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _toU96(uint256 x) internal pure returns (uint96) {
        if (x > type(uint96).max) revert AmountTooLarge();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint96(x);
    }
}
