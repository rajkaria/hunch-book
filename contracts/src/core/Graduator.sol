// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IGraduator} from "../interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IKuruMarginAccount} from "../interfaces/external/IKuruMarginAccount.sol";
import {IKuruOrderBook, KuruMarketParams, KuruVaultParams} from "../interfaces/external/IKuruOrderBook.sol";
import {IKuruRouter} from "../interfaces/external/IKuruRouter.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title Graduator
/// @notice Gives each Hunch Book market its Kuru YES/USDC order book (docs/PROTOCOL.md §8.1).
/// Holds no funds and has no admin: the book parameters and the creation flag are fixed at deploy.
///
/// Testnet (`canCreateBooks` = true): `createBook` calls Kuru's `Router.deployProxy`, which is open to
/// anyone there. Mainnet (`canCreateBooks` = false): only Kuru's owner can create markets, so Kuru
/// creates the book and anyone calls `registerBook`.
///
/// Every book this contract records, created or registered, has passed the same check (`_verify`):
/// - Kuru's MarginAccount lists it as a verified market (only Kuru's Router can add one);
/// - base = the market's YES token, quote = the protocol's USDC;
/// - pricePrecision, sizePrecision, tickSize, minSize, takerFeeBps, makerFeeBps and the AMM spread
///   equal `bookParams()`, and maxSize equals the market's pool cap;
/// - sizePrecision = 10^(YES decimals) and pricePrecision = 10^(USDC decimals), so a Kuru size is a
///   YES base unit and a Kuru quote amount is a USDC base unit. HunchRouter relies on this.
/// Kuru salts each book's CREATE2 address with all of these parameters, so for a given Kuru book
/// implementation exactly one address can pass. In particular nobody can register a look-alike book
/// with a higher taker fee or a maker rebate to themselves.
///
/// Front-running on testnet. Anyone can call Kuru's `deployProxy` with our exact parameters before
/// we do (the YES token exists from market creation). That book is then the canonical one and our
/// own `deployProxy` call would collide. `createBook` checks Kuru's predicted address first and adopts
/// a book already deployed there (after the same verification), so `IMarket.graduate` is not blocked.
contract Graduator is IGraduator {
    error ZeroAddress();
    error CollateralMismatch();
    error InvalidBookParams();
    error InvalidPoolCap();

    /// Kuru `OrderBookType.NO_NATIVE`: both assets are ERC-20.
    uint8 internal constant KURU_NO_NATIVE = 0;
    uint256 internal constant BPS = 10_000;
    /// YES and NO are 6-decimal tokens (IOutcomeToken), so sizePrecision must be 1e6.
    uint256 internal constant OUTCOME_TOKEN_UNIT = 1e6;

    IHunchBookFactory public immutable factory;
    IKuruRouter public immutable kuruRouter;
    IKuruMarginAccount public immutable kuruMarginAccount;
    address public immutable usdc;
    bool public immutable canCreateBooks;

    uint96 internal immutable _sizePrecision;
    uint32 internal immutable _pricePrecision;
    uint32 internal immutable _tickSize;
    uint96 internal immutable _minSize;
    uint256 internal immutable _takerFeeBps;
    uint256 internal immutable _makerFeeBps;
    uint96 internal immutable _kuruAmmSpread;

    mapping(address market => address book) public bookOf;

    /// @param factory_ The Hunch Book factory whose markets get books.
    /// @param kuruRouter_ Kuru's Router (market factory).
    /// @param kuruMarginAccount_ Kuru's MarginAccount (registry of verified books).
    /// @param usdc_ The protocol's collateral; must equal `factory_.usdc()`.
    /// @param canCreateBooks_ True where Kuru's `deployProxy` is open to us (testnet).
    /// @param params Book parameters, validated against Kuru's own rules so `createBook` cannot fail
    ///        on them later.
    constructor(
        IHunchBookFactory factory_,
        IKuruRouter kuruRouter_,
        IKuruMarginAccount kuruMarginAccount_,
        address usdc_,
        bool canCreateBooks_,
        BookParams memory params
    ) {
        if (
            address(factory_) == address(0) || address(kuruRouter_) == address(0)
                || address(kuruMarginAccount_) == address(0) || usdc_ == address(0)
        ) revert ZeroAddress();
        if (factory_.usdc() != usdc_) revert CollateralMismatch();

        // Kuru's Router: precisions are powers of ten and tickSize > 0.
        // Kuru's OrderBook: makerFeeBps <= takerFeeBps < 10000; spread % 10 == 0 and 0 < spread < 500;
        // 0 < minSize < maxSize (maxSize is the pool cap, checked per market).
        if (!_isPowerOfTen(params.sizePrecision) || !_isPowerOfTen(params.pricePrecision)) {
            revert InvalidBookParams();
        }
        if (params.tickSize == 0 || params.minSize == 0) revert InvalidBookParams();
        if (params.makerFeeBps > params.takerFeeBps || params.takerFeeBps >= BPS) revert InvalidBookParams();
        if (params.kuruAmmSpread % 10 != 0 || params.kuruAmmSpread == 0 || params.kuruAmmSpread >= 500) {
            revert InvalidBookParams();
        }
        // One Kuru quote unit must be one USDC base unit and one Kuru size unit one YES base unit
        // (HunchRouter passes token amounts to Kuru unchanged). `_verify` checks both again per book.
        if (10 ** uint256(IERC20Decimals(usdc_).decimals()) != params.pricePrecision) revert InvalidBookParams();
        if (params.sizePrecision != OUTCOME_TOKEN_UNIT) revert InvalidBookParams();

        factory = factory_;
        kuruRouter = kuruRouter_;
        kuruMarginAccount = kuruMarginAccount_;
        usdc = usdc_;
        canCreateBooks = canCreateBooks_;

        _sizePrecision = params.sizePrecision;
        _pricePrecision = params.pricePrecision;
        _tickSize = params.tickSize;
        _minSize = params.minSize;
        _takerFeeBps = params.takerFeeBps;
        _makerFeeBps = params.makerFeeBps;
        _kuruAmmSpread = params.kuruAmmSpread;
    }

    /// @inheritdoc IGraduator
    /// @dev Anyone can call it. Deploys with maxSize = the market's pool cap. If a book with these
    /// exact parameters already sits at Kuru's predicted address (someone called `deployProxy` first),
    /// adopts it instead and emits `BookRegistered`.
    function createBook(address market) external returns (address book) {
        if (!factory.isMarket(market)) revert UnknownMarket();
        if (bookOf[market] != address(0)) revert BookExists();
        if (!canCreateBooks) revert CreationNotSupported();

        (address yes,) = IMarket(market).tokens();
        uint96 maxSize = _maxSizeOf(market);

        address predicted = kuruRouter.computeAddress(
            yes,
            usdc,
            _sizePrecision,
            _pricePrecision,
            _tickSize,
            _minSize,
            maxSize,
            _takerFeeBps,
            _makerFeeBps,
            _kuruAmmSpread,
            address(0),
            false
        );
        if (predicted.code.length != 0) {
            _verify(market, predicted);
            bookOf[market] = predicted;
            emit BookRegistered(market, predicted, msg.sender);
            return predicted;
        }

        book = kuruRouter.deployProxy(
            KURU_NO_NATIVE,
            yes,
            usdc,
            _sizePrecision,
            _pricePrecision,
            _tickSize,
            _minSize,
            maxSize,
            _takerFeeBps,
            _makerFeeBps,
            _kuruAmmSpread
        );
        _verify(market, book);
        bookOf[market] = book;
        emit BookCreated(market, book);
    }

    /// @inheritdoc IGraduator
    /// @dev Anyone can call it, on any network. Reverts `BookMismatch` unless `book` passes `_verify`.
    function registerBook(address market, address book) external {
        if (!factory.isMarket(market)) revert UnknownMarket();
        if (bookOf[market] != address(0)) revert BookExists();
        _verify(market, book);
        bookOf[market] = book;
        emit BookRegistered(market, book, msg.sender);
    }

    /// @inheritdoc IGraduator
    function bookParams() external view returns (BookParams memory) {
        return BookParams({
            sizePrecision: _sizePrecision,
            pricePrecision: _pricePrecision,
            tickSize: _tickSize,
            minSize: _minSize,
            takerFeeBps: _takerFeeBps,
            makerFeeBps: _makerFeeBps,
            kuruAmmSpread: _kuruAmmSpread
        });
    }

    /// Kuru's maxSize for this market's book: the pool cap, which must fit Kuru's uint96 and exceed minSize.
    function _maxSizeOf(address market) internal view returns (uint96) {
        uint256 poolCap = IMarket(market).caps().poolCap;
        if (poolCap > type(uint96).max || poolCap <= _minSize) revert InvalidPoolCap();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint96(poolCap);
    }

    /// Reverts `BookMismatch` unless `book` is a Kuru-registered book for this market's YES token and
    /// USDC with exactly the Hunch Book parameters (see the contract notes).
    function _verify(address market, address book) internal view {
        if (book.code.length == 0) revert BookMismatch();
        if (!kuruMarginAccount.verifiedMarket(book)) revert BookMismatch();

        KuruMarketParams memory p = _marketParams(book);
        (address yes,) = IMarket(market).tokens();
        if (p.baseAsset != yes || p.quoteAsset != usdc) revert BookMismatch();
        if (
            p.pricePrecision != _pricePrecision || p.sizePrecision != _sizePrecision || p.tickSize != _tickSize
                || p.minSize != _minSize || p.maxSize != _maxSizeOf(market)
        ) revert BookMismatch();
        if (p.takerFeeBps != _takerFeeBps || p.makerFeeBps != _makerFeeBps) revert BookMismatch();
        // Kuru records the token decimals it read at creation. Units must be token base units.
        if (p.baseAssetDecimals > 28 || 10 ** p.baseAssetDecimals != p.sizePrecision) revert BookMismatch();
        if (p.quoteAssetDecimals > 28 || 10 ** p.quoteAssetDecimals != p.pricePrecision) revert BookMismatch();

        if (_vaultParams(book).kuruAmmSpread != _kuruAmmSpread) revert BookMismatch();
    }

    function _marketParams(address book) internal view returns (KuruMarketParams memory) {
        (bool ok, bytes memory ret) = book.staticcall(abi.encodeCall(IKuruOrderBook.getMarketParams, ()));
        if (!ok || ret.length < 352) revert BookMismatch();
        return abi.decode(ret, (KuruMarketParams));
    }

    function _vaultParams(address book) internal view returns (KuruVaultParams memory) {
        (bool ok, bytes memory ret) = book.staticcall(abi.encodeCall(IKuruOrderBook.getVaultParams, ()));
        if (!ok || ret.length < 256) revert BookMismatch();
        return abi.decode(ret, (KuruVaultParams));
    }

    function _isPowerOfTen(uint256 x) internal pure returns (bool) {
        if (x == 0) return false;
        while (x % 10 == 0) {
            x /= 10;
        }
        return x == 1;
    }
}
