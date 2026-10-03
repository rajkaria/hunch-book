// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ResolverText} from "../../src/resolvers/ResolverText.sol";

contract ResolverTextTest is Test {
    function test_decimal() public pure {
        assertEq(ResolverText.decimal(0, 0), "0");
        assertEq(ResolverText.decimal(0, 8), "0");
        assertEq(ResolverText.decimal(7, 0), "7");
        assertEq(ResolverText.decimal(999, 0), "999");
        assertEq(ResolverText.decimal(1000, 0), "1,000");
        assertEq(ResolverText.decimal(1_234_567, 0), "1,234,567");
        assertEq(ResolverText.decimal(5, 1), "0.5");
        assertEq(ResolverText.decimal(123_450, 2), "1,234.5");
        assertEq(ResolverText.decimal(100, 2), "1");
        assertEq(ResolverText.decimal(1, 8), "0.00000001");
        assertEq(ResolverText.decimal(999, 3), "0.999");
        assertEq(ResolverText.decimal(8_500_000_000_000, 8), "85,000");
        assertEq(ResolverText.decimal(8_469_662_693_406, 8), "84,696.62693406");
        assertEq(ResolverText.decimal(1, 100), string.concat("0.", LibString.repeat("0", 99), "1"));
    }

    function test_usdAndSigned() public pure {
        assertEq(ResolverText.usd(0, 8), "$0");
        assertEq(ResolverText.usd(-12_345, 1), "-$1,234.5");
        assertEq(ResolverText.usd(3_124_000, 8), "$0.03124");
        assertEq(ResolverText.signedDecimal(-36_874, 0), "-36,874");
        assertEq(ResolverText.signedDecimal(15, 1), "1.5");
        assertEq(
            ResolverText.usd(type(int256).min, 0),
            "-$57,896,044,618,658,097,711,785,492,504,343,953,926,634,992,332,820,282,019,728,792,003,956,564,819,968"
        );
    }

    function test_utc() public pure {
        assertEq(ResolverText.utc(0), "1970-01-01 00:00:00 UTC");
        assertEq(ResolverText.utc(1_791_115_200), "2026-10-04 12:00:00 UTC");
        assertEq(ResolverText.utc(1_791_030_045), "2026-10-03 12:20:45 UTC");
        assertEq(ResolverText.utc(4_102_444_799), "2099-12-31 23:59:59 UTC");
        assertEq(ResolverText.utc(type(uint64).max), "unix time 18446744073709551615");
    }

    function test_compactPair() public pure {
        assertEq(ResolverText.compactPair("BTC / USD"), "BTC/USD");
        assertEq(ResolverText.compactPair("MON/USD"), "MON/USD");
    }

    /// Formatting round-trips: removing separators and the point gives back the digits.
    function testFuzz_decimalRoundTrip(uint256 value, uint8 decimals) public pure {
        decimals = uint8(bound(decimals, 0, 30));
        string memory s = ResolverText.decimal(value, decimals);
        string memory plain = LibString.replace(s, ",", "");
        (string memory whole, string memory frac) = _split(plain);
        uint256 w = vm.parseUint(whole);
        uint256 fracLen = bytes(frac).length;
        assertLe(fracLen, decimals);
        uint256 f = fracLen == 0 ? 0 : vm.parseUint(frac);
        assertEq(w * 10 ** decimals + f * 10 ** (decimals - fracLen), value);
    }

    function _split(string memory s) internal pure returns (string memory, string memory) {
        uint256 i = LibString.indexOf(s, ".");
        if (i == LibString.NOT_FOUND) return (s, "");
        return (LibString.slice(s, 0, i), LibString.slice(s, i + 1));
    }
}
