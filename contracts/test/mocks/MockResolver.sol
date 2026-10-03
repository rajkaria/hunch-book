// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IResolver} from "../../src/interfaces/IResolver.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";

/// Test-only resolver. Params are abi.encode(Window); the outcome is whatever the test set,
/// which stands in for "what the source says". Real resolvers only read their source.
contract MockResolver is IResolver {
    Outcome public answer;
    bool public early;
    bool public revertOnResolve;
    uint256 public lastValue;
    uint256 public refund;

    function setAnswer(Outcome o) external {
        answer = o;
    }

    function setEarly(bool e) external {
        early = e;
    }

    function setRevertOnResolve(bool r) external {
        revertOnResolve = r;
    }

    function setRefund(uint256 r) external {
        refund = r;
    }

    function validate(bytes calldata params) external pure returns (Window memory) {
        return abi.decode(params, (Window));
    }

    function describe(bytes calldata) external pure returns (string memory) {
        return "Test question.";
    }

    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash)
    {
        require(!revertOnResolve, "source reverted");
        lastValue = msg.value;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
        return (answer, keccak256(abi.encode(params, evidence, answer)));
    }

    function earlyYes() external view returns (bool) {
        return early;
    }
}
