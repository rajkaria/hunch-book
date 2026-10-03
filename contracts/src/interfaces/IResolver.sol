// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Outcome, Window} from "./IHunchBookTypes.sol";

/// A template: a pure reader of one onchain source plus a parameter schema.
/// Resolvers hold no funds and no admin keys. No address can make one return a chosen outcome.
interface IResolver {
    /// Reverts if `params` are invalid (unknown feed or perp, window in the past, bad ordering).
    /// Returns the market's window. Called once, at market creation.
    function validate(bytes calldata params) external view returns (Window memory);

    /// One plain-English sentence describing the exact rule, shown next to the market.
    function describe(bytes calldata params) external view returns (string memory);

    /// Reads the source. Returns `Outcome.Unresolved` if the answer cannot be determined yet
    /// (for example, the observation block is not final). Never returns a guess.
    /// Reverts if `evidence` is malformed or points at the wrong data.
    /// `evidenceHash` commits to exactly what was read, for the settlement verifier.
    /// Payable because Pyth charges an update fee; unused value is refunded to `msg.sender`.
    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash);

    /// True for touch templates, which can settle YES before close from a proof.
    function earlyYes() external view returns (bool);
}
