// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {GraduationRule} from "../src/interfaces/IHunchBookTypes.sol";

/// The graduation rule a deployment registers its templates with (PROTOCOL.md §5.3, §12), from the
/// environment, so Deploy.s.sol and GuardianBatch.s.sol cannot disagree:
///
///   GRADUATION_MIN_POOL     USDC in whole units, 10 to 5000 (default 500, the v0 rule)
///   GRADUATION_MIN_STAKERS  distinct stakers, 2 to 100 (default 10)
///
/// The chance band is fixed at 3% to 97%. A template's rule is set once, when the guardian adds it.
abstract contract GraduationRuleEnv is Script {
    uint256 public constant DEFAULT_MIN_POOL = 500;
    uint256 public constant DEFAULT_MIN_STAKERS = 10;

    function graduationRule() public view returns (GraduationRule memory) {
        uint256 minPool = vm.envOr("GRADUATION_MIN_POOL", DEFAULT_MIN_POOL);
        uint256 minStakers = vm.envOr("GRADUATION_MIN_STAKERS", DEFAULT_MIN_STAKERS);
        return ruleOf(minPool, minStakers);
    }

    /// The rule for `minPool` whole USDC and `minStakers` stakers, with the bounds checked.
    function ruleOf(uint256 minPool, uint256 minStakers) public pure returns (GraduationRule memory) {
        require(minPool >= 10 && minPool <= 5000, "GRADUATION_MIN_POOL out of range");
        require(minStakers >= 2 && minStakers <= 100, "GRADUATION_MIN_STAKERS out of range");
        return GraduationRule({
            // forge-lint: disable-next-line(unsafe-typecast)
            minPool: uint128(minPool * 1e6),
            // forge-lint: disable-next-line(unsafe-typecast)
            minStakers: uint32(minStakers),
            minChanceBps: 300,
            maxChanceBps: 9700
        });
    }
}
