// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// The parts of Kuru's Router (market factory) that Hunch Book uses. Signatures match
/// Kuru-contracts-dex-public `Router.sol` and the deployed contracts on Monad.
interface IKuruRouter {
    /// Emitted by `deployProxy`. No field is indexed; `market` is the third word of the data.
    event MarketRegistered(
        address baseAsset,
        address quoteAsset,
        address market,
        address vaultAddress,
        uint32 pricePrecision,
        uint96 sizePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 kuruAmmSpread
    );

    /// Deploys a book (and its AMM vault) at a CREATE2 address salted by every parameter, and
    /// registers it in the MarginAccount. `_type` 0 = NO_NATIVE (both assets are ERC-20).
    /// Kuru checks: precisions are powers of ten, tickSize > 0, makerFeeBps <= takerFeeBps < 10000,
    /// kuruAmmSpread % 10 == 0 and 0 < kuruAmmSpread < 500, 0 < minSize < maxSize.
    /// Open to anyone on Monad testnet; owner-only on Monad mainnet (reverts `Unauthorized()`).
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
    ) external returns (address proxy);

    /// The address `deployProxy` would use for these parameters with the current book
    /// implementation (`old` = false) or with `oldImplementation` (`old` = true).
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
    ) external view returns (address proxy);
}
