// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KuruMarketParams} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {MockKuruMarginAccount} from "./MockKuruMarginAccount.sol";
import {MockKuruOrderBook} from "./MockKuruOrderBook.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// Kuru's Router as the Graduator sees it: `deployProxy` validates like Kuru, deploys a
/// MockKuruOrderBook at a CREATE2 address salted by every parameter (so a second identical call
/// collides and reverts), registers it in the MarginAccount, and `computeAddress` predicts it.
/// `ownerOnly` reproduces mainnet, where only Kuru's owner may call `deployProxy`.
contract MockKuruRouter {
    error Unauthorized();
    error InvalidSizePrecision();
    error InvalidPricePrecision();
    error InvalidTickSize();
    error MarketFeeError();
    error InvalidSpread();
    error MarketSizeError();
    error MarketTypeMismatch();

    MockKuruMarginAccount public immutable marginAccount;
    address public immutable owner;
    bool public ownerOnly;

    uint256 public deployCount;
    address public lastDeployed;

    constructor(MockKuruMarginAccount marginAccount_) {
        marginAccount = marginAccount_;
        owner = msg.sender;
    }

    function setOwnerOnly(bool on) external {
        ownerOnly = on;
    }

    function deployProxy(
        uint8 _type,
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 spread
    ) external returns (address proxy) {
        if (ownerOnly && msg.sender != owner) revert Unauthorized();
        if (_type != 0 || base == address(0) || quote == address(0) || base == quote) revert MarketTypeMismatch();
        if (tickSize == 0) revert InvalidTickSize();
        if (!_pow10(sizePrecision)) revert InvalidSizePrecision();
        if (!_pow10(pricePrecision)) revert InvalidPricePrecision();
        if (makerFeeBps > takerFeeBps || takerFeeBps >= 10_000) revert MarketFeeError();
        if (spread % 10 != 0 || spread == 0 || spread >= 500) revert InvalidSpread();
        if (minSize == 0 || maxSize <= minSize) revert MarketSizeError();

        KuruMarketParams memory p =
            _params(base, quote, sizePrecision, pricePrecision, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps);
        bytes32 salt = keccak256(
            abi.encodePacked(
                base, quote, sizePrecision, pricePrecision, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps, spread
            )
        );
        proxy = address(new MockKuruOrderBook{salt: salt}(p, spread));
        marginAccount.updateMarkets(proxy);
        ++deployCount;
        lastDeployed = proxy;
    }

    function computeAddress(
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 spread,
        address,
        bool
    ) external view returns (address) {
        KuruMarketParams memory p = _params(
            base, quote, sizePrecision, pricePrecision, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps
        );
        bytes32 salt = keccak256(
            abi.encodePacked(
                base, quote, sizePrecision, pricePrecision, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps, spread
            )
        );
        bytes32 initHash = keccak256(abi.encodePacked(type(MockKuruOrderBook).creationCode, abi.encode(p, spread)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function _params(
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps
    ) internal view returns (KuruMarketParams memory p) {
        p.pricePrecision = pricePrecision;
        p.sizePrecision = sizePrecision;
        p.baseAsset = base;
        p.baseAssetDecimals = IDecimals(base).decimals();
        p.quoteAsset = quote;
        p.quoteAssetDecimals = IDecimals(quote).decimals();
        p.tickSize = tickSize;
        p.minSize = minSize;
        p.maxSize = maxSize;
        p.takerFeeBps = takerFeeBps;
        p.makerFeeBps = makerFeeBps;
    }

    function _pow10(uint256 x) internal pure returns (bool) {
        if (x == 0) return false;
        while (x % 10 == 0) {
            x /= 10;
        }
        return x == 1;
    }
}
