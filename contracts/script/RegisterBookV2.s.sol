// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IGraduatorV2} from "../src/interfaces/IGraduatorV2.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IMarket} from "../src/interfaces/IMarket.sol";

/// Kuru v2 book flow (PROTOCOL.md §8.1, Kuru v2). Kuru governance creates each market's YES/USDC book
/// from what GraduatorV2 publishes; anyone registers it, and GraduatorV2 checks it first. The keeper
/// does both steps on its own; this script is the manual path.
///
/// Print what to ask Kuru for, where the book will be, and what is missing (no key, sends nothing):
///   MARKET=0x... forge script script/RegisterBookV2.s.sol --sig "request()" --rpc-url <rpc>
///
/// Register the book (BOOK defaults to the predicted address; any funded key):
///   MARKET=0x... [BOOK=0x...] REGISTRAR_PRIVATE_KEY=... forge script script/RegisterBookV2.s.sol \
///     --rpc-url <rpc> --broadcast
contract RegisterBookV2 is Script {
    string[12] internal problems = [
        "none",
        "no contract at that address",
        "Kuru's SpotRouter did not deploy it",
        "Kuru's AccountCore has not registered it",
        "it points at another AccountCore",
        "its base or quote is not this market's YES token and USDC",
        "its precisions are not 1e6 / 1e6",
        "its tick size is outside the limits",
        "its fees are outside the limits",
        "its minimum order is above the limit",
        "Kuru has not enabled the YES token or USDC in AccountCore",
        "the WithdrawalLimiter has no price source for the YES token or USDC"
    ];

    /// The deploySpotMarket arguments Kuru should use, the predicted address, and its state.
    function request() external view {
        IMarket market = IMarket(vm.envAddress("MARKET"));
        IGraduatorV2 g = _graduator(market);
        IGraduatorV2.BookRequest memory r = g.bookRequest(address(market));
        address predicted = g.predictedBook(address(market));

        console2.log("Kuru v2 SpotRouter.deploySpotMarket for Hunch Book market", address(market));
        console2.log("  baseToken          YES token", r.baseToken);
        console2.log("  quoteToken         USDC", r.quoteToken);
        console2.log("  sizePrecision     ", uint256(r.sizePrecision));
        console2.log("  pricePrecision    ", uint256(r.pricePrecision));
        console2.log("  tickSize          ", uint256(r.tickSize));
        console2.log("  passiveSpreadTicks", uint256(r.passiveSpreadTicks));
        console2.log("  minQuoteNotional  ", uint256(r.minQuoteNotional));
        console2.log("  maxQuoteNotional   pool cap", uint256(r.maxQuoteNotional));
        console2.log("  takerFeePps       ", r.takerFeePps);
        console2.log("  makerFeePps       ", r.makerFeePps);
        console2.log("Predicted book address", predicted);

        address registered = g.bookOf(address(market));
        if (registered != address(0)) {
            console2.log("Registered book:", registered);
            return;
        }
        IGraduatorV2.Problem p = g.bookProblem(address(market), predicted);
        if (p == IGraduatorV2.Problem.None) console2.log("The predicted book is ready to register.");
        else console2.log("Not registrable yet:", problems[uint256(p)]);
    }

    function run() external {
        IMarket market = IMarket(vm.envAddress("MARKET"));
        IGraduatorV2 g = _graduator(market);
        address book = vm.envOr("BOOK", g.predictedBook(address(market)));
        require(g.bookOf(address(market)) == address(0), "book already registered");
        IGraduatorV2.Problem p = g.bookProblem(address(market), book);
        require(p == IGraduatorV2.Problem.None, problems[uint256(p)]);

        vm.startBroadcast(vm.envUint("REGISTRAR_PRIVATE_KEY"));
        g.registerBook(address(market), book);
        vm.stopBroadcast();

        require(g.bookOf(address(market)) == book, "registration did not stick");
        console2.log("registered book", book, "for market", address(market));
    }

    function _graduator(IMarket market) internal view returns (IGraduatorV2 g) {
        g = IGraduatorV2(IHunchBookFactory(market.factory()).graduator());
        require(address(g) != address(0), "this stack has no graduator yet (WireKuruV2.s.sol)");
        (bool ok, bytes memory ret) = address(g).staticcall(abi.encodeCall(IGraduatorV2.kuruVersion, ()));
        require(ok && ret.length == 32 && abi.decode(ret, (uint8)) == 2, "not a Kuru v2 stack: use RegisterBook.s.sol");
    }
}
