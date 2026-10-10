// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibClone} from "solady/utils/LibClone.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IKuruRouter} from "../interfaces/external/IKuruRouter.sol";
import {HunchMarginAccount} from "./HunchMarginAccount.sol";
import {HunchOrderBook} from "./HunchOrderBook.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IOutcomeTokenMarket {
    function market() external view returns (address);
}

/// @title HunchOrderBookFactory
/// @notice Creates Hunch Book's own order books (docs/PROTOCOL.md §8.1, "Hunch order book"). It has
/// Kuru v1 Router's `deployProxy`, `computeAddress` and `MarketRegistered`, so the v1 Graduator creates
/// books here exactly as it does on Kuru's testnet, on any network. Anyone can call `deployProxy`; it
/// has no owner and nothing to configure.
///
/// Every book is a minimal clone of one HunchOrderBook implementation at a CREATE2 address salted by all
/// ten parameters, so for given parameters exactly one book can exist and `computeAddress` predicts it.
/// A book is created only for:
/// - base = the YES token of a market the Hunch Book factory created, quote = that factory's USDC;
/// - sizePrecision = 10^(YES decimals), pricePrecision = 10^(USDC decimals);
/// - a tick that divides pricePrecision into at most MAX_LEVELS levels; 0 < minSize < maxSize;
/// - fees 0 and 0 (Hunch's book charges none);
/// - Kuru's AMM-spread rule (multiple of 10, between 10 and 490), recorded only: there is no AMM vault.
/// The constructor deploys the shared HunchMarginAccount and the book implementation.
contract HunchOrderBookFactory is IKuruRouter {
    error ZeroAddressNotAllowed();
    error MarketTypeMismatch();
    error NotHunchMarket();
    error WrongQuoteAsset();
    error InvalidSizePrecision();
    error InvalidPricePrecision();
    error InvalidTickSize();
    error MarketSizeError();
    error MarketFeeError();
    error InvalidSpread();

    /// Kuru `OrderBookType.NO_NATIVE`: both assets are ERC-20. The only type supported.
    uint8 internal constant NO_NATIVE = 0;
    /// Most price levels a book may have (16 bitmap words).
    uint256 public constant MAX_LEVELS = 4096;

    IHunchBookFactory public immutable hunchFactory;
    address public immutable usdc;
    HunchMarginAccount public immutable marginAccount;
    address public immutable implementation;

    /// Books created, in order.
    address[] public books;

    struct Params {
        address base;
        address quote;
        uint96 sizePrecision;
        uint32 pricePrecision;
        uint32 tickSize;
        uint96 minSize;
        uint96 maxSize;
        uint256 takerFeeBps;
        uint256 makerFeeBps;
        uint96 kuruAmmSpread;
    }

    constructor(IHunchBookFactory hunchFactory_) {
        if (address(hunchFactory_) == address(0)) revert ZeroAddressNotAllowed();
        address usdc_ = hunchFactory_.usdc();
        if (usdc_ == address(0)) revert ZeroAddressNotAllowed();
        hunchFactory = hunchFactory_;
        usdc = usdc_;
        marginAccount = new HunchMarginAccount(address(this));
        implementation = address(new HunchOrderBook());
    }

    /// @inheritdoc IKuruRouter
    function deployProxy(
        uint8 _type,
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread
    ) external returns (address proxy) {
        if (_type != NO_NATIVE) revert MarketTypeMismatch();
        Params memory p = Params({
            base: _baseAssetAddress,
            quote: _quoteAssetAddress,
            sizePrecision: _sizePrecision,
            pricePrecision: _pricePrecision,
            tickSize: _tickSize,
            minSize: _minSize,
            maxSize: _maxSize,
            takerFeeBps: _takerFeeBps,
            makerFeeBps: _makerFeeBps,
            kuruAmmSpread: _kuruAmmSpread
        });
        proxy = _deploy(p);
    }

    /// @inheritdoc IKuruRouter
    /// @dev `old` = true predicts with `oldImplementation` instead of the current implementation.
    function computeAddress(
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread,
        address oldImplementation,
        bool old
    ) external view returns (address) {
        Params memory p = Params({
            base: _baseAssetAddress,
            quote: _quoteAssetAddress,
            sizePrecision: _sizePrecision,
            pricePrecision: _pricePrecision,
            tickSize: _tickSize,
            minSize: _minSize,
            maxSize: _maxSize,
            takerFeeBps: _takerFeeBps,
            makerFeeBps: _makerFeeBps,
            kuruAmmSpread: _kuruAmmSpread
        });
        return LibClone.predictDeterministicAddress(old ? oldImplementation : implementation, _salt(p), address(this));
    }

    /// The number of books created.
    function bookCount() external view returns (uint256) {
        return books.length;
    }

    function _deploy(Params memory p) internal returns (address proxy) {
        address market = _marketOf(p.base);
        if (p.quote != usdc) revert WrongQuoteAsset();
        uint8 baseDecimals = IERC20Decimals(p.base).decimals();
        uint8 quoteDecimals = IERC20Decimals(p.quote).decimals();
        if (baseDecimals > 28 || p.sizePrecision != 10 ** uint256(baseDecimals)) revert InvalidSizePrecision();
        if (quoteDecimals > 9 || p.pricePrecision != 10 ** uint256(quoteDecimals)) revert InvalidPricePrecision();
        if (p.tickSize == 0 || p.pricePrecision % p.tickSize != 0 || p.pricePrecision / p.tickSize > MAX_LEVELS) {
            revert InvalidTickSize();
        }
        if (p.minSize == 0 || p.maxSize <= p.minSize) revert MarketSizeError();
        if (p.takerFeeBps != 0 || p.makerFeeBps != 0) revert MarketFeeError();
        if (p.kuruAmmSpread % 10 != 0 || p.kuruAmmSpread == 0 || p.kuruAmmSpread >= 500) revert InvalidSpread();

        proxy = LibClone.cloneDeterministic(implementation, _salt(p));
        _initialize(proxy, market, p, baseDecimals, quoteDecimals);
        marginAccount.registerBook(proxy);
        books.push(proxy);
        _emitRegistered(proxy, p);
    }

    function _initialize(address proxy, address market, Params memory p, uint8 baseDecimals, uint8 quoteDecimals)
        internal
    {
        HunchOrderBook(proxy)
            .initialize(
                marginAccount,
                market,
                p.base,
                p.quote,
                p.pricePrecision,
                p.sizePrecision,
                p.tickSize,
                p.minSize,
                p.maxSize,
                p.kuruAmmSpread,
                baseDecimals,
                quoteDecimals
            );
    }

    function _emitRegistered(address proxy, Params memory p) internal {
        emit MarketRegistered(
            p.base,
            p.quote,
            proxy,
            address(0),
            p.pricePrecision,
            p.sizePrecision,
            p.tickSize,
            p.minSize,
            p.maxSize,
            p.takerFeeBps,
            p.makerFeeBps,
            p.kuruAmmSpread
        );
    }

    /// The Hunch Book market whose YES token is `base`. Reverts `NotHunchMarket` for anything else.
    function _marketOf(address base) internal view returns (address market) {
        if (base.code.length == 0) revert NotHunchMarket();
        (bool ok, bytes memory ret) = base.staticcall(abi.encodeCall(IOutcomeTokenMarket.market, ()));
        if (!ok || ret.length < 32) revert NotHunchMarket();
        market = abi.decode(ret, (address));
        if (!hunchFactory.isMarket(market)) revert NotHunchMarket();
        (address yes,) = IMarket(market).tokens();
        if (yes != base) revert NotHunchMarket();
    }

    function _salt(Params memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }
}
