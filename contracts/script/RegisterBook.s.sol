// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IGraduator} from "../src/interfaces/IGraduator.sol";
import {IMarket} from "../src/interfaces/IMarket.sol";

/// Mainnet book flow (PROTOCOL.md §8.1). Kuru's mainnet market creation is owner-only, so Kuru creates
/// each market's YES/USDC book and anyone registers it with the Graduator, which verifies it.
///
/// Print what to ask Kuru for (no key needed, sends nothing):
///   MARKET=0x... forge script script/RegisterBook.s.sol --sig "request()" --rpc-url <rpc>
///
/// Register the book Kuru created (any funded key; the Graduator checks everything):
///   MARKET=0x... BOOK=0x... REGISTRAR_PRIVATE_KEY=... forge script script/RegisterBook.s.sol \
///     --rpc-url <rpc> --broadcast
contract RegisterBook is Script {
    /// The exact `deployProxy` arguments Kuru must use for this market's book.
    function request() external view {
        IMarket market = IMarket(vm.envAddress("MARKET"));
        IGraduator graduator = _graduator(market);
        IGraduator.BookParams memory p = graduator.bookParams();
        (address yes,) = market.tokens();
        address usdc = _usdc(market);

        console2.log("Kuru Router.deployProxy for Hunch Book market", address(market));
        console2.log("  _type              0 (both assets are ERC-20)");
        console2.log("  _baseAssetAddress  YES token", yes);
        console2.log("  _quoteAssetAddress USDC", usdc);
        console2.log("  _sizePrecision    ", uint256(p.sizePrecision));
        console2.log("  _pricePrecision   ", uint256(p.pricePrecision));
        console2.log("  _tickSize         ", uint256(p.tickSize));
        console2.log("  _minSize          ", uint256(p.minSize));
        console2.log("  _maxSize           pool cap", uint256(market.caps().poolCap));
        console2.log("  _takerFeeBps      ", p.takerFeeBps);
        console2.log("  _makerFeeBps      ", p.makerFeeBps);
        console2.log("  _kuruAmmSpread    ", uint256(p.kuruAmmSpread));
        address existing = graduator.bookOf(address(market));
        if (existing != address(0)) console2.log("A book is already registered:", existing);
    }

    function run() external {
        IMarket market = IMarket(vm.envAddress("MARKET"));
        address book = vm.envAddress("BOOK");
        IGraduator graduator = _graduator(market);
        require(graduator.bookOf(address(market)) == address(0), "book already registered");

        vm.startBroadcast(vm.envUint("REGISTRAR_PRIVATE_KEY"));
        graduator.registerBook(address(market), book);
        vm.stopBroadcast();

        require(graduator.bookOf(address(market)) == book, "registration did not stick");
        console2.log("registered book", book, "for market", address(market));
        console2.log("graduate() is now possible once the pool meets its rule");
    }

    function _graduator(IMarket market) internal view returns (IGraduator) {
        (bool ok, bytes memory ret) = market.factory().staticcall(abi.encodeWithSignature("graduator()"));
        require(ok && ret.length == 32, "factory has no graduator");
        return IGraduator(abi.decode(ret, (address)));
    }

    function _usdc(IMarket market) internal view returns (address) {
        (bool ok, bytes memory ret) = market.factory().staticcall(abi.encodeWithSignature("usdc()"));
        require(ok && ret.length == 32, "factory has no usdc");
        return abi.decode(ret, (address));
    }
}
