// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Gives each market its Kuru v2 YES/USDC book. Holds no funds, has no admin.
///
/// On Kuru v2 only Kuru's governance can create books (SpotRouter.deploySpotMarket), so this graduator
/// never creates one: Kuru deploys the book from the parameters this contract publishes
/// (`bookRequest`), and anyone calls `registerBook`, which accepts it only after `bookProblem` finds
/// nothing wrong (PROTOCOL.md §8.1, Kuru v2). `Market.graduate` reads `bookOf` and `canCreateBooks`
/// (false), so a market graduates only once its book is registered.
///
/// It keeps the function selectors Market calls on a graduator (`bookOf`, `canCreateBooks`,
/// `createBook`) and the v1 events, so the factory, markets and indexers treat it like the v1 Graduator.
interface IGraduatorV2 {
    /// The parameters Hunch Book asks Kuru to create each book with (maxQuoteNotional is per market:
    /// the market's pool cap).
    struct RequestedParams {
        uint96 sizePrecision; // 1e6: one size unit is one YES base unit
        uint32 pricePrecision; // 1e6: one price unit is one USDC base unit per YES
        uint32 tickSize; // 1000 = 0.001 USDC
        uint32 passiveSpreadTicks; // Kuru requires > 0
        uint96 minQuoteNotional; // smallest resting order, in USDC base units
        uint256 takerFeePps; // parts per 10^7
        uint256 makerFeePps;
    }

    /// What a registered book may differ in from the request. Precisions, tokens and Kuru's registries
    /// must match exactly; these bound the rest.
    struct Limits {
        uint32 maxTickSize;
        uint96 maxMinQuoteNotional;
        uint256 maxTakerFeePps;
    }

    /// Everything Kuru needs to create one market's book.
    struct BookRequest {
        address baseToken;
        address quoteToken;
        uint96 sizePrecision;
        uint32 pricePrecision;
        uint32 tickSize;
        uint32 passiveSpreadTicks;
        uint96 minQuoteNotional;
        uint96 maxQuoteNotional;
        uint256 takerFeePps;
        uint256 makerFeePps;
    }

    /// Why `bookProblem` rejects a book (`None` = it would be accepted).
    enum Problem {
        None,
        NoCode,
        NotVerifiedBySpotRouter,
        NotRegisteredInAccountCore,
        WrongAccountCore,
        WrongTokens,
        WrongPrecision,
        BadTickSize,
        BadFees,
        BadMinQuoteNotional,
        TokenNotEnabled,
        NoPriceSource
    }

    event BookCreated(address indexed market, address indexed book);
    event BookRegistered(address indexed market, address indexed book, address registrar);

    error UnknownMarket();
    error BookExists();
    error CreationNotSupported();
    error BookMismatch(Problem problem);

    /// Always reverts `CreationNotSupported`: Kuru creates v2 books.
    function createBook(address market) external returns (address book);

    /// Records `book` for `market` after checking it (`bookProblem` must be `None`). Anyone can call it.
    function registerBook(address market, address book) external;

    /// `None` if `registerBook(market, book)` would accept `book` now, otherwise the first problem found.
    /// Reverts `UnknownMarket` for an address the factory did not create.
    function bookProblem(address market, address book) external view returns (Problem);

    function bookRequest(address market) external view returns (BookRequest memory);

    /// Where Kuru's SpotRouter would deploy a book with exactly `bookRequest(market)`.
    function predictedBook(address market) external view returns (address);

    function bookOf(address market) external view returns (address);
    function canCreateBooks() external view returns (bool);
    /// 2.
    function kuruVersion() external pure returns (uint8);
    function requestedParams() external view returns (RequestedParams memory);
    function limits() external view returns (Limits memory);
}
