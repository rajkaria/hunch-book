// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Gives each market its Kuru YES/USDC book. Holds no funds.
/// Testnet: Kuru market creation is permissionless, so `createBook` calls Kuru's Router.deployProxy.
/// Mainnet: only Kuru's owner can create markets, so Kuru creates the book and anyone registers it;
/// `registerBook` accepts it only if Kuru's MarginAccount knows it and its base, quote and
/// precisions match the market's YES token, USDC and the Hunch Book parameters (PROTOCOL.md §8.1).
interface IGraduator {
    struct BookParams {
        uint96 sizePrecision; // 1e6
        uint32 pricePrecision; // 1e6
        uint32 tickSize; // 1_000 = 0.001 USDC
        uint96 minSize; // 1e6 = 1 YES
        uint256 takerFeeBps;
        uint256 makerFeeBps;
        uint96 kuruAmmSpread;
    }

    event BookCreated(address indexed market, address indexed book);
    event BookRegistered(address indexed market, address indexed book, address registrar);

    error UnknownMarket();
    error BookExists();
    error CreationNotSupported();
    error BookMismatch();

    /// Creates the market's Kuru book. Reverts where Kuru market creation is not open to us.
    /// Anyone can call it (a book can be prepared while the pool fills); `IMarket.graduate` calls it
    /// if no book is registered yet.
    function createBook(address market) external returns (address book);

    /// Registers a book Kuru created for this market, after verifying it.
    function registerBook(address market, address book) external;

    function bookOf(address market) external view returns (address);
    function canCreateBooks() external view returns (bool);
    function bookParams() external view returns (BookParams memory);
}
