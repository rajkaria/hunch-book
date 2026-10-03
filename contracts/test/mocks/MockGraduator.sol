// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IGraduator} from "../../src/interfaces/IGraduator.sol";

/// Test-only graduator: hands out a fresh placeholder address as each market's book.
/// The real Graduator (Kuru) is tested in its own suites.
contract MockGraduator is IGraduator {
    mapping(address => address) public bookOf;
    bool public canCreateBooks = true;
    uint256 internal _n;

    function setCanCreate(bool c) external {
        canCreateBooks = c;
    }

    function createBook(address market) external returns (address book) {
        if (!canCreateBooks) revert CreationNotSupported();
        if (bookOf[market] != address(0)) revert BookExists();
        book = address(uint160(0xB00C000 + ++_n));
        bookOf[market] = book;
        emit BookCreated(market, book);
    }

    function registerBook(address market, address book) external {
        if (bookOf[market] != address(0)) revert BookExists();
        bookOf[market] = book;
        emit BookRegistered(market, book, msg.sender);
    }

    function bookParams() external pure returns (BookParams memory p) {
        p.sizePrecision = 1e6;
        p.pricePrecision = 1e6;
        p.tickSize = 1000;
        p.minSize = 1e6;
        p.kuruAmmSpread = 30;
    }
}
