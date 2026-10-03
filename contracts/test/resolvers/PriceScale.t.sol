// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PriceScale} from "../../src/resolvers/PriceScale.sol";

contract PriceScaleTest is Test {
    function scale(int256 value, int256 exponent) external pure returns (int256) {
        return PriceScale.toE8(value, exponent);
    }

    function test_examples() public pure {
        assertEq(PriceScale.toE8(8_469_662_693_406, -8), 8_469_662_693_406); // Chainlink, 8 decimals
        assertEq(PriceScale.toE8(2_684_866_294_790_000_000_001, -18), 268_486_629_479); // 18 decimals truncate
        assertEq(PriceScale.toE8(31_240, -6), 3_124_000); // 6 decimals scale up
        assertEq(PriceScale.toE8(15_012_345, -5), 15_012_345_000); // Pyth expo −5
        assertEq(PriceScale.toE8(7, 0), 7e8);
        assertEq(PriceScale.toE8(7, 3), 7e11);
        assertEq(PriceScale.toE8(1, -9), 0);
        assertEq(PriceScale.toE8(-15, -9), -1); // truncates toward zero
        assertEq(PriceScale.toE8(type(int256).max, -85), 0);
        assertEq(PriceScale.toE8(type(int256).max, -84), 5); // 5.789e76 / 10^76
        assertEq(PriceScale.toE8(0, 1000), 0);
    }

    function test_overflowReverts() public {
        vm.expectRevert(PriceScale.ScaleOverflow.selector);
        this.scale(1, 69); // shift 77
        vm.expectRevert(); // checked multiplication
        this.scale(type(int256).max, 0);
        this.scale(5, 68); // shift 76 fits: 5e76 < 5.79e76
    }

    /// Down-scaling is a floor for positive prices, so "at or above an integer strike" is exact.
    function testFuzz_floorPreservesAtOrAbove(uint256 value, uint8 decimals, uint256 strike) public pure {
        decimals = uint8(bound(decimals, 8, 40));
        value = bound(value, 1, 1e36);
        strike = bound(strike, 1, 1e30);
        int256 e8 = PriceScale.toE8(int256(value), -int256(uint256(decimals)));
        bool viaScale = e8 >= int256(strike);
        bool exact = value >= strike * 10 ** (decimals - 8);
        assertEq(viaScale, exact);
    }

    /// Up-scaling is exact.
    function testFuzz_upscaleExact(uint256 value, uint8 decimals) public pure {
        decimals = uint8(bound(decimals, 0, 8));
        value = bound(value, 0, 1e60);
        assertEq(PriceScale.toE8(int256(value), -int256(uint256(decimals))), int256(value * 10 ** (8 - decimals)));
    }
}
