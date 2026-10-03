// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {MockTokenForRouter} from "../mocks/MockVaultForRouter.sol";
import {KuruForkBase} from "./KuruForkBase.sol";

/// The Graduator against Kuru's live testnet Router and MarginAccount.
contract KuruGraduatorForkTest is KuruForkBase {
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        _fork();
    }

    function _deployDirect(address base, address quote, IGraduator.BookParams memory p, uint96 maxSize)
        internal
        returns (address)
    {
        vm.prank(outsider);
        return kuruRouter.deployProxy(
            0,
            base,
            quote,
            p.sizePrecision,
            p.pricePrecision,
            p.tickSize,
            p.minSize,
            maxSize,
            p.takerFeeBps,
            p.makerFeeBps,
            p.kuruAmmSpread
        );
    }

    /// createBook deploys a real book with our parameters; Kuru lists it and reports them back.
    function test_fork_createBook() public {
        Graduator grad = _graduator(true, _params(0, 0));
        address predicted = kuruRouter.computeAddress(
            address(yes), address(usdc), 1e6, 1e6, 1000, 1e6, uint96(POOL_CAP), 0, 0, 30, address(0), false
        );

        uint256 g = gasleft();
        address book = grad.createBook(address(market));
        console2.log("createBook gas (deployProxy + verification):", g - gasleft());

        assertEq(book, predicted, "Kuru's predicted address");
        assertEq(grad.bookOf(address(market)), book);
        assertTrue(kuruMarginAccount.verifiedMarket(book));
        (
            uint32 pP,
            uint96 sP,
            address base,
            uint256 bd,
            address quote,
            uint256 qd,
            uint32 tick,
            uint96 minS,
            uint96 maxS,,
        ) = IKuruOrderBook(book).getMarketParams();
        assertEq(pP, 1e6);
        assertEq(sP, 1e6);
        assertEq(base, address(yes));
        assertEq(bd, 6);
        assertEq(quote, address(usdc));
        assertEq(qd, 6);
        assertEq(tick, 1000);
        assertEq(minS, 1e6);
        assertEq(maxS, POOL_CAP);
        (uint256 bid, uint256 ask) = IKuruOrderBook(book).bestBidAsk();
        assertEq(bid, type(uint256).max, "empty bid sentinel");
        assertEq(ask, 0, "empty ask sentinel");
    }

    /// Mainnet flow on testnet: a book created directly through Kuru with matching parameters is accepted.
    function test_fork_registerBook_acceptsMatchingBook() public {
        Graduator grad = _graduator(false, _params(0, 0));
        address book = _deployDirect(address(yes), address(usdc), _params(0, 0), uint96(POOL_CAP));
        vm.prank(outsider);
        grad.registerBook(address(market), book);
        assertEq(grad.bookOf(address(market)), book);
    }

    function test_fork_registerBook_rejectsMismatches() public {
        Graduator grad = _graduator(false, _params(0, 0));
        MockTokenForRouter other = new MockTokenForRouter("Other", "OTH", 6);
        IGraduator.BookParams memory p;

        // Base: the NO token, then an unrelated token.
        _expectRejected(grad, _deployDirect(address(no), address(usdc), _params(0, 0), uint96(POOL_CAP)));
        _expectRejected(grad, _deployDirect(address(other), address(usdc), _params(0, 0), uint96(POOL_CAP)));
        // Quote: not the protocol's USDC.
        _expectRejected(grad, _deployDirect(address(yes), address(other), _params(0, 0), uint96(POOL_CAP)));
        // Precisions and tick.
        p = _params(0, 0);
        p.sizePrecision = 1e5;
        _expectRejected(grad, _deployDirect(address(yes), address(usdc), p, uint96(POOL_CAP)));
        p = _params(0, 0);
        p.pricePrecision = 1e7;
        _expectRejected(grad, _deployDirect(address(yes), address(usdc), p, uint96(POOL_CAP)));
        p = _params(0, 0);
        p.tickSize = 100;
        _expectRejected(grad, _deployDirect(address(yes), address(usdc), p, uint96(POOL_CAP)));
        // Fees: a 99.99% taker fee rebated to the maker would hand every taker trade to the book's maker.
        p = _params(9999, 9999);
        _expectRejected(grad, _deployDirect(address(yes), address(usdc), p, uint96(POOL_CAP)));
        // Max size other than the pool cap, and another AMM spread.
        _expectRejected(grad, _deployDirect(address(yes), address(usdc), _params(0, 0), uint96(POOL_CAP) + 1));
        p = _params(0, 0);
        p.kuruAmmSpread = 50;
        _expectRejected(grad, _deployDirect(address(yes), address(usdc), p, uint96(POOL_CAP)));

        // None of them stuck; the matching book still registers.
        address good = _deployDirect(address(yes), address(usdc), _params(0, 0), uint96(POOL_CAP));
        grad.registerBook(address(market), good);
        assertEq(grad.bookOf(address(market)), good);
    }

    /// Someone deploys our exact book first. Kuru's own deployProxy would now collide; createBook adopts it.
    function test_fork_createBook_adoptsFrontRunBook() public {
        Graduator grad = _graduator(true, _params(0, 0));
        address front = _deployDirect(address(yes), address(usdc), _params(0, 0), uint96(POOL_CAP));

        vm.expectRevert();
        _deployDirect(address(yes), address(usdc), _params(0, 0), uint96(POOL_CAP));

        address book = grad.createBook(address(market));
        assertEq(book, front);
        assertEq(grad.bookOf(address(market)), front);
    }

    function _expectRejected(Graduator grad, address book) internal {
        assertTrue(kuruMarginAccount.verifiedMarket(book), "a real Kuru book");
        vm.expectRevert(IGraduator.BookMismatch.selector);
        grad.registerBook(address(market), book);
    }
}
