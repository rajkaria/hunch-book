// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Converts a price `value × 10^exponent` to 8 decimals (USD × 1e8), the unit of `strikeE8`.
/// Scaling down truncates. For a positive price and an integer strike that is exact for the rule:
/// floor(x) >= K if and only if x >= K, so truncation can never flip "at or above the strike".
library PriceScale {
    /// 10^76 is the largest power of ten below type(int256).max.
    int256 internal constant MAX_POW10 = 76;

    error ScaleOverflow();

    /// @param value the raw price (Chainlink answer, Pyth price)
    /// @param exponent the price's power of ten (Chainlink: −decimals; Pyth: expo)
    function toE8(int256 value, int256 exponent) internal pure returns (int256) {
        int256 shift = exponent + 8;
        if (shift >= 0) {
            if (shift > MAX_POW10) {
                if (value == 0) return 0;
                revert ScaleOverflow();
            }
            // Safe: 0 <= shift <= 76, and 10^76 < type(int256).max. The multiplication is checked.
            // forge-lint: disable-next-line(unsafe-typecast)
            return value * int256(10 ** uint256(shift));
        }
        // |int256| < 10^77, so dividing by 10^77 or more always gives 0.
        if (shift < -MAX_POW10) return 0;
        // Safe: 1 <= -shift <= 76, and 10^76 < type(int256).max.
        // forge-lint: disable-next-line(unsafe-typecast)
        return value / int256(10 ** uint256(-shift));
    }
}
