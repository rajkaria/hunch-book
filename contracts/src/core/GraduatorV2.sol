// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IGraduatorV2} from "../interfaces/IGraduatorV2.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {
    IKuruAccountCore,
    IKuruSpotOrderBook,
    IKuruSpotRouter,
    IKuruWithdrawalLimiter
} from "../interfaces/external/IKuruV2.sol";

interface IERC20DecimalsV2 {
    function decimals() external view returns (uint8);
}

/// @title GraduatorV2
/// @notice Gives each Hunch Book market its Kuru v2 YES/USDC order book (docs/PROTOCOL.md §8.1, Kuru v2).
/// Holds no funds and has no admin: Kuru's addresses, the requested parameters and the limits are fixed
/// at deploy.
///
/// Kuru governance creates every v2 book. This contract publishes what to create (`bookRequest`, with
/// maxQuoteNotional = the market's pool cap) and where it would land (`predictedBook`), and records a
/// book for a market only if `bookProblem` finds nothing wrong:
/// - Kuru's SpotRouter deployed it and Kuru's AccountCore registered it, with this market's YES token as
///   base and the protocol's USDC as quote in AccountCore's own records;
/// - the book reports the same AccountCore, base and quote;
/// - pricePrecision = 10^(USDC decimals) and sizePrecision = 10^6 (one YES), so a Kuru price is USDC base
///   units per YES and a Kuru size is YES base units. HunchRouterV2 relies on this;
/// - 0 < tickSize <= maxTickSize, makerFee <= takerFee <= maxTakerFeePps, minQuoteNotional <= the limit;
/// - AccountCore has both tokens enabled and the WithdrawalLimiter has a price source for both, so
///   deposits and withdrawals work the moment the market graduates.
/// Only books Kuru created pass the first two checks, so nobody else can plant a book. A registration is
/// permanent; Kuru's books are upgradeable, so HunchRouterV2 still checks every fill on its own balances.
contract GraduatorV2 is IGraduatorV2 {
    error ZeroAddress();
    error CollateralMismatch();
    error InvalidParams();
    error InvalidPoolCap();

    uint8 internal constant KURU_VERSION = 2;
    /// YES and NO are 6-decimal tokens (IOutcomeToken), so a size unit of 1e6 is one token.
    uint96 internal constant OUTCOME_TOKEN_UNIT = 1e6;
    /// Kuru caps fees at 1% (10^5 pps).
    uint256 internal constant KURU_MAX_FEE_PPS = 100_000;

    IHunchBookFactory public immutable factory;
    IKuruSpotRouter public immutable spotRouter;
    IKuruAccountCore public immutable accountCore;
    address public immutable usdc;

    uint32 internal immutable _pricePrecision;
    uint32 internal immutable _tickSize;
    uint32 internal immutable _passiveSpreadTicks;
    uint96 internal immutable _minQuoteNotional;
    uint256 internal immutable _takerFeePps;
    uint256 internal immutable _makerFeePps;
    uint32 internal immutable _maxTickSize;
    uint96 internal immutable _maxMinQuoteNotional;
    uint256 internal immutable _maxTakerFeePps;

    mapping(address market => address book) public bookOf;

    /// @param factory_ The Hunch Book factory whose markets get books.
    /// @param spotRouter_ Kuru's v2 SpotRouter (market factory).
    /// @param accountCore_ Kuru's v2 AccountCore (balances and book registry).
    /// @param usdc_ The protocol's collateral; must equal `factory_.usdc()`.
    /// @param requested What Hunch Book asks Kuru to create; must itself pass the limits.
    /// @param limits_ What a registered book may differ in.
    constructor(
        IHunchBookFactory factory_,
        IKuruSpotRouter spotRouter_,
        IKuruAccountCore accountCore_,
        address usdc_,
        RequestedParams memory requested,
        Limits memory limits_
    ) {
        if (
            address(factory_) == address(0) || address(spotRouter_) == address(0) || address(accountCore_) == address(0)
                || usdc_ == address(0)
        ) revert ZeroAddress();
        if (factory_.usdc() != usdc_) revert CollateralMismatch();

        uint256 usdcUnit = 10 ** uint256(IERC20DecimalsV2(usdc_).decimals());
        if (requested.sizePrecision != OUTCOME_TOKEN_UNIT || requested.pricePrecision != usdcUnit) {
            revert InvalidParams();
        }
        if (limits_.maxTakerFeePps > KURU_MAX_FEE_PPS || limits_.maxTickSize == 0) revert InvalidParams();
        // The request must be registrable, and must meet Kuru's own rules for a new book.
        if (requested.tickSize == 0 || requested.tickSize > limits_.maxTickSize) revert InvalidParams();
        if (requested.makerFeePps > requested.takerFeePps || requested.takerFeePps > limits_.maxTakerFeePps) {
            revert InvalidParams();
        }
        if (requested.minQuoteNotional == 0 || requested.minQuoteNotional > limits_.maxMinQuoteNotional) {
            revert InvalidParams();
        }
        if (requested.passiveSpreadTicks == 0) revert InvalidParams();

        factory = factory_;
        spotRouter = spotRouter_;
        accountCore = accountCore_;
        usdc = usdc_;

        _pricePrecision = requested.pricePrecision;
        _tickSize = requested.tickSize;
        _passiveSpreadTicks = requested.passiveSpreadTicks;
        _minQuoteNotional = requested.minQuoteNotional;
        _takerFeePps = requested.takerFeePps;
        _makerFeePps = requested.makerFeePps;
        _maxTickSize = limits_.maxTickSize;
        _maxMinQuoteNotional = limits_.maxMinQuoteNotional;
        _maxTakerFeePps = limits_.maxTakerFeePps;
    }

    // ------------------------------------------------------------------------------------------
    // Books
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IGraduatorV2
    function createBook(address) external pure returns (address) {
        revert CreationNotSupported();
    }

    /// @inheritdoc IGraduatorV2
    function registerBook(address market, address book) external {
        if (!factory.isMarket(market)) revert UnknownMarket();
        if (bookOf[market] != address(0)) revert BookExists();
        Problem p = _problem(market, book);
        if (p != Problem.None) revert BookMismatch(p);
        bookOf[market] = book;
        emit BookRegistered(market, book, msg.sender);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IGraduatorV2
    function bookProblem(address market, address book) external view returns (Problem) {
        if (!factory.isMarket(market)) revert UnknownMarket();
        return _problem(market, book);
    }

    /// @inheritdoc IGraduatorV2
    function bookRequest(address market) public view returns (BookRequest memory r) {
        if (!factory.isMarket(market)) revert UnknownMarket();
        (address yes,) = IMarket(market).tokens();
        r.baseToken = yes;
        r.quoteToken = usdc;
        r.sizePrecision = OUTCOME_TOKEN_UNIT;
        r.pricePrecision = _pricePrecision;
        r.tickSize = _tickSize;
        r.passiveSpreadTicks = _passiveSpreadTicks;
        r.minQuoteNotional = _minQuoteNotional;
        r.maxQuoteNotional = _maxQuoteNotionalOf(market);
        r.takerFeePps = _takerFeePps;
        r.makerFeePps = _makerFeePps;
    }

    /// @inheritdoc IGraduatorV2
    function predictedBook(address market) external view returns (address) {
        BookRequest memory r = bookRequest(market);
        return spotRouter.computeAddress(
            r.baseToken,
            r.quoteToken,
            r.sizePrecision,
            r.pricePrecision,
            r.tickSize,
            r.passiveSpreadTicks,
            r.minQuoteNotional,
            r.maxQuoteNotional,
            r.takerFeePps,
            r.makerFeePps
        );
    }

    /// @inheritdoc IGraduatorV2
    function canCreateBooks() external pure returns (bool) {
        return false;
    }

    /// @inheritdoc IGraduatorV2
    function kuruVersion() external pure returns (uint8) {
        return KURU_VERSION;
    }

    /// @inheritdoc IGraduatorV2
    function requestedParams() external view returns (RequestedParams memory) {
        return RequestedParams({
            sizePrecision: OUTCOME_TOKEN_UNIT,
            pricePrecision: _pricePrecision,
            tickSize: _tickSize,
            passiveSpreadTicks: _passiveSpreadTicks,
            minQuoteNotional: _minQuoteNotional,
            takerFeePps: _takerFeePps,
            makerFeePps: _makerFeePps
        });
    }

    /// @inheritdoc IGraduatorV2
    function limits() external view returns (Limits memory) {
        return
            Limits({
                maxTickSize: _maxTickSize, maxMinQuoteNotional: _maxMinQuoteNotional, maxTakerFeePps: _maxTakerFeePps
            });
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    /// The pool cap, as Kuru's uint96 maxQuoteNotional; must exceed the requested minQuoteNotional.
    function _maxQuoteNotionalOf(address market) internal view returns (uint96) {
        uint256 poolCap = IMarket(market).caps().poolCap;
        if (poolCap > type(uint96).max || poolCap <= _minQuoteNotional) revert InvalidPoolCap();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint96(poolCap);
    }

    /// The first reason `book` cannot be this market's book, or `None`. Kuru's registries are checked
    /// before any call into `book`, so only a book Kuru deployed is ever called.
    function _problem(address market, address book) internal view returns (Problem) {
        if (book.code.length == 0) return Problem.NoCode;
        if (!spotRouter.verifiedSpotMarket(book)) return Problem.NotVerifiedBySpotRouter;
        if (!accountCore.verifiedSpotOrderBook(book)) return Problem.NotRegisteredInAccountCore;

        (address yes,) = IMarket(market).tokens();
        address quote = usdc;
        if (accountCore.spotOrderBookToBaseToken(book) != yes || accountCore.spotOrderBookToQuoteToken(book) != quote) {
            return Problem.WrongTokens;
        }

        IKuruSpotOrderBook b = IKuruSpotOrderBook(book);
        if (b.accountCore() != address(accountCore)) return Problem.WrongAccountCore;
        if (b.baseToken() != yes || b.quoteToken() != quote) return Problem.WrongTokens;
        if (b.pricePrecision() != _pricePrecision || b.sizePrecision() != OUTCOME_TOKEN_UNIT) {
            return Problem.WrongPrecision;
        }
        uint32 tick = b.tickSize();
        if (tick == 0 || tick > _maxTickSize) return Problem.BadTickSize;
        uint256 taker = b.takerFeePps();
        if (b.makerFeePps() > taker || taker > _maxTakerFeePps) return Problem.BadFees;
        if (b.minQuoteNotional() > _maxMinQuoteNotional) return Problem.BadMinQuoteNotional;

        (, bool yesEnabled) = accountCore.spotTokenConfigs(yes);
        (, bool usdcEnabled) = accountCore.spotTokenConfigs(quote);
        if (!yesEnabled || !usdcEnabled) return Problem.TokenNotEnabled;
        IKuruWithdrawalLimiter limiter = IKuruWithdrawalLimiter(accountCore.withdrawalLimiter());
        if (address(limiter) != address(0)) {
            if (limiter.priceSource(yes) == address(0) || limiter.priceSource(quote) == address(0)) {
                return Problem.NoPriceSource;
            }
        }
        return Problem.None;
    }
}
