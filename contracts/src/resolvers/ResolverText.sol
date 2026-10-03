// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";

/// Number and time formatting for the one-sentence rules that resolvers return from `describe`.
/// View-only helpers: nothing here is used to decide an outcome.
library ResolverText {
    /// "$84,696.5", "-$0.25", "$0".
    function usd(int256 value, uint256 decimals) internal pure returns (string memory) {
        if (value < 0) return string.concat("-$", decimal(_abs(value), decimals));
        // Safe: value >= 0 here.
        // forge-lint: disable-next-line(unsafe-typecast)
        return string.concat("$", decimal(uint256(value), decimals));
    }

    /// "-36,874", "1.5".
    function signedDecimal(int256 value, uint256 decimals) internal pure returns (string memory) {
        if (value < 0) return string.concat("-", decimal(_abs(value), decimals));
        // Safe: value >= 0 here.
        // forge-lint: disable-next-line(unsafe-typecast)
        return decimal(uint256(value), decimals);
    }

    /// `value / 10^decimals` written out exactly, with thousands separators and no trailing zeros.
    function decimal(uint256 value, uint256 decimals) internal pure returns (string memory) {
        string memory digits = LibString.toString(value);
        uint256 n = bytes(digits).length;
        string memory whole;
        string memory frac;
        if (n > decimals) {
            whole = LibString.slice(digits, 0, n - decimals);
            frac = LibString.slice(digits, n - decimals);
        } else {
            whole = "0";
            frac = string.concat(LibString.repeat("0", decimals - n), digits);
        }
        bytes memory f = bytes(frac);
        uint256 end = f.length;
        while (end > 0 && f[end - 1] == "0") --end;
        if (end == 0) return _group(whole);
        return string.concat(_group(whole), ".", LibString.slice(frac, 0, end));
    }

    /// "2026-10-04 12:00:00 UTC". Falls back to "unix time N" past the calendar range Solady supports.
    function utc(uint256 timestamp) internal pure returns (string memory) {
        if (!DateTimeLib.isSupportedTimestamp(timestamp)) {
            return string.concat("unix time ", LibString.toString(timestamp));
        }
        (uint256 y, uint256 mo, uint256 d, uint256 h, uint256 mi, uint256 s) =
            DateTimeLib.timestampToDateTime(timestamp);
        return string.concat(
            LibString.toString(y), "-", _two(mo), "-", _two(d), " ", _two(h), ":", _two(mi), ":", _two(s), " UTC"
        );
    }

    /// "BTC / USD" -> "BTC/USD".
    function compactPair(string memory pair) internal pure returns (string memory) {
        return LibString.replace(pair, " ", "");
    }

    function _two(uint256 v) private pure returns (string memory) {
        return v < 10 ? string.concat("0", LibString.toString(v)) : LibString.toString(v);
    }

    /// Inserts a comma every three digits from the right: "1234567" -> "1,234,567".
    function _group(string memory digits) private pure returns (string memory) {
        bytes memory src = bytes(digits);
        uint256 n = src.length;
        if (n <= 3) return digits;
        bytes memory out = new bytes(n + (n - 1) / 3);
        uint256 j = out.length;
        uint256 k = 0;
        for (uint256 i = n; i > 0; --i) {
            if (k == 3) {
                out[--j] = ",";
                k = 0;
            }
            out[--j] = src[i - 1];
            ++k;
        }
        return string(out);
    }

    function _abs(int256 v) private pure returns (uint256) {
        // Two's complement magnitude; correct for type(int256).min as well.
        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast)
            return v < 0 ? uint256(~v) + 1 : uint256(v);
        }
    }
}
