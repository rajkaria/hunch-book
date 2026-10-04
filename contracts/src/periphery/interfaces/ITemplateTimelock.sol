// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IResolver} from "../../interfaces/IResolver.sol";
import {GraduationRule, MarketCaps} from "../../interfaces/IHunchBookTypes.sol";

/// A public delay in front of the factory's guardian powers (roadmap O-11, docs/PERIPHERY.md). Meant
/// to become the factory's guardian. The proposer (a multisig) queues new templates, caps, the
/// collateral cap and guardian transfers; each change waits `delay` seconds in public, with its full
/// calldata in the `OperationQueued` event, so anyone can review a template before it can go live.
/// After the delay anyone can execute it (within `GRACE_PERIOD`); until then the proposer can cancel it.
/// Pauses go straight through, because pausing creation or graduation only protects users.
/// The timelock adds no power of its own: the factory's guardian can never touch settlement,
/// redemption, outcomes or funds, and neither can this contract.
interface ITemplateTimelock {
    event OperationQueued(
        bytes32 indexed id, uint256 indexed nonce, bytes4 indexed selector, bytes data, uint256 readyAt
    );
    event OperationExecuted(bytes32 indexed id, uint256 indexed nonce, address indexed executor);
    event OperationCancelled(bytes32 indexed id);
    event CreationPauseSet(bool paused);
    event GraduationPauseSet(bool paused);
    event GuardianAccepted();

    error OnlyProposer();
    error ZeroAddress();
    error DelayOutOfRange();
    error NotAContract();
    error TemplateExists();
    error UnknownOperation(bytes32 id);
    error NotReady(bytes32 id, uint256 readyAt);
    error OperationStale(bytes32 id);
    error Reentrancy();

    /// Proposer only. Queues `factory.addTemplate(templateId, resolver, rule)`. The resolver must have
    /// code and the id must be unused when queued (the factory checks again on execution).
    function queueAddTemplate(uint32 templateId, IResolver resolver, GraduationRule calldata rule)
        external
        returns (bytes32 id);

    /// Proposer only. Queues `factory.setCaps(caps)` (applies to markets created after execution).
    function queueSetCaps(MarketCaps calldata caps) external returns (bytes32 id);

    /// Proposer only. Queues `factory.setCollateralCap(cap)`.
    function queueSetCollateralCap(uint256 cap) external returns (bytes32 id);

    /// Proposer only. Queues `factory.transferGuardian(pending)`; `pending` then calls acceptGuardian.
    function queueTransferGuardian(address pending) external returns (bytes32 id);

    /// Anyone, from `readyAt` until `readyAt + GRACE_PERIOD`. `data` and `nonce` come from the
    /// `OperationQueued` event. Calls the factory with `data` and bubbles up any revert.
    function execute(bytes calldata data, uint256 nonce) external;

    /// Proposer only. Drops a queued operation.
    function cancel(bytes32 id) external;

    /// Proposer only, no delay. `factory.setCreationPaused(paused)`.
    function setCreationPaused(bool paused) external;

    /// Proposer only, no delay. `factory.setGraduationPaused(paused)`.
    function setGraduationPaused(bool paused) external;

    /// Anyone. Completes a guardian transfer to this contract (`factory.acceptGuardian()`), which only
    /// succeeds if the current guardian named this contract as pending guardian.
    function acceptGuardian() external;

    /// keccak256(abi.encode(data, nonce)).
    function operationId(bytes calldata data, uint256 nonce) external pure returns (bytes32);

    /// When a queued operation can run (0 if unknown, executed or cancelled).
    function readyAt(bytes32 id) external view returns (uint256);

    function factory() external view returns (address);
    function proposer() external view returns (address);
    function delay() external view returns (uint256);
    /// Operations queued so far; the next one gets this nonce.
    function operationCount() external view returns (uint256);
    function MIN_DELAY() external view returns (uint256);
    function MAX_DELAY() external view returns (uint256);
    function GRACE_PERIOD() external view returns (uint256);
}
