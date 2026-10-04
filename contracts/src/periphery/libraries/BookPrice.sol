// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKuruOrderBook} from "../../interfaces/external/IKuruOrderBook.sol";

/// @title BookPrice
/// @notice Reads the best YES bid and ask of a Hunch Book market's Kuru book as E6 prices (USDC base
/// units per 1 YES, so 0.42 USDC is 420000), and derives NO prices from them.
///
/// Kuru's `bestBidAsk()` returns prices scaled to 1e18 and marks an empty side with a sentinel: an
/// empty bid reads as type(uint256).max and an empty ask as 0 (PROTOCOL.md §8.1). The Graduator only
/// accepts books with pricePrecision = 1e6, so dividing by 1e12 gives E6. Bids round down and asks
/// round up, so a price read here is never better than the book. A zero bid or a uint256 max ask is
/// also treated as empty, and a book that reverts or returns malformed data reads as empty on both
/// sides, so a broken book can never produce a price.
///
/// NO trades through the YES book (HunchRouter): buying NO sells YES into the bids and selling NO buys
/// YES from the asks, so NO bid = 1 USDC - YES ask and NO ask = 1 USDC - YES bid (both floored at 0).
library BookPrice {
    /// 1 USDC per token, in E6.
    uint256 internal constant ONE = 1e6;
    /// bestBidAsk() scale (1e18) divided by the Hunch book price scale (1e6).
    uint256 internal constant SCALE_DOWN = 1e12;

    /// The YES side of the book in E6. Prices are not capped at 1 USDC.
    struct Quote {
        bool hasBid;
        bool hasAsk;
        uint256 bid;
        uint256 ask;
    }

    /// Reads `book.bestBidAsk()`. Returns an empty quote for an address with no code.
    function yesQuote(address book) internal view returns (Quote memory q) {
        if (book.code.length == 0) return q;
        (bool ok, bytes memory ret) = book.staticcall(abi.encodeCall(IKuruOrderBook.bestBidAsk, ()));
        if (!ok || ret.length < 64) return q;
        (uint256 bid, uint256 ask) = abi.decode(ret, (uint256, uint256));
        if (bid != type(uint256).max && bid != 0) {
            q.hasBid = true;
            q.bid = bid / SCALE_DOWN;
        }
        if (ask != 0 && ask != type(uint256).max) {
            q.hasAsk = true;
            q.ask = (ask - 1) / SCALE_DOWN + 1;
        }
    }

    /// 1 USDC minus `price`, floored at 0.
    function complement(uint256 price) internal pure returns (uint256) {
        return price >= ONE ? 0 : ONE - price;
    }

    /// `price` capped at 1 USDC.
    function capped(uint256 price) internal pure returns (uint256) {
        return price > ONE ? ONE : price;
    }
}
