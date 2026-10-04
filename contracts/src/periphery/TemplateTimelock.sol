// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {GraduationRule, MarketCaps} from "../interfaces/IHunchBookTypes.sol";
import {ITemplateTimelock} from "./interfaces/ITemplateTimelock.sol";

/// @title TemplateTimelock
/// @notice A public review delay for new templates and limits (roadmap O-11). See ITemplateTimelock
/// and docs/PERIPHERY.md.
///
/// Only the four typed `queue*` functions can create an operation, so `execute` can only ever call
/// `addTemplate`, `setCaps`, `setCollateralCap` or `transferGuardian` on the factory, with exactly the
/// arguments that were public for `delay` seconds. The proposer and the delay are fixed; to change
/// either, deploy a new timelock and queue `transferGuardian` to it, which itself waits the delay.
contract TemplateTimelock is ITemplateTimelock {
    /// @inheritdoc ITemplateTimelock
    uint256 public constant MIN_DELAY = 2 days;
    /// @inheritdoc ITemplateTimelock
    uint256 public constant MAX_DELAY = 30 days;
    /// @inheritdoc ITemplateTimelock
    uint256 public constant GRACE_PERIOD = 14 days;

    /// @inheritdoc ITemplateTimelock
    address public immutable factory;
    /// @inheritdoc ITemplateTimelock
    address public immutable proposer;
    /// @inheritdoc ITemplateTimelock
    uint256 public immutable delay;

    /// @inheritdoc ITemplateTimelock
    uint256 public operationCount;
    /// @inheritdoc ITemplateTimelock
    mapping(bytes32 id => uint256) public readyAt;

    bool private transient _locked;

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyProposer() {
        if (msg.sender != proposer) revert OnlyProposer();
        _;
    }

    /// @param factory_ The factory whose guardian this contract will become.
    /// @param proposer_ The multisig that queues and cancels operations and sets pauses.
    /// @param delay_ Seconds between queueing and execution, from MIN_DELAY (2 days) to MAX_DELAY.
    constructor(IHunchBookFactory factory_, address proposer_, uint256 delay_) {
        if (address(factory_) == address(0) || proposer_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert DelayOutOfRange();
        factory = address(factory_);
        proposer = proposer_;
        delay = delay_;
    }

    // ------------------------------------------------------------------------------------------
    // Queue (proposer)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ITemplateTimelock
    function queueAddTemplate(uint32 templateId, IResolver resolver, GraduationRule calldata rule)
        external
        onlyProposer
        returns (bytes32 id)
    {
        if (address(resolver).code.length == 0) revert NotAContract();
        if (address(IHunchBookFactory(factory).resolverOf(templateId)) != address(0)) revert TemplateExists();
        return _queue(abi.encodeCall(IHunchBookFactory.addTemplate, (templateId, resolver, rule)));
    }

    /// @inheritdoc ITemplateTimelock
    function queueSetCaps(MarketCaps calldata caps) external onlyProposer returns (bytes32 id) {
        return _queue(abi.encodeCall(IHunchBookFactory.setCaps, (caps)));
    }

    /// @inheritdoc ITemplateTimelock
    function queueSetCollateralCap(uint256 cap) external onlyProposer returns (bytes32 id) {
        return _queue(abi.encodeCall(IHunchBookFactory.setCollateralCap, (cap)));
    }

    /// @inheritdoc ITemplateTimelock
    function queueTransferGuardian(address pending) external onlyProposer returns (bytes32 id) {
        return _queue(abi.encodeCall(IHunchBookFactory.transferGuardian, (pending)));
    }

    /// @inheritdoc ITemplateTimelock
    function cancel(bytes32 id) external onlyProposer {
        if (readyAt[id] == 0) revert UnknownOperation(id);
        delete readyAt[id];
        emit OperationCancelled(id);
    }

    // ------------------------------------------------------------------------------------------
    // Execute (anyone)
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ITemplateTimelock
    function execute(bytes calldata data, uint256 nonce) external nonReentrant {
        bytes32 id = operationId(data, nonce);
        uint256 t = readyAt[id];
        if (t == 0) revert UnknownOperation(id);
        if (block.timestamp < t) revert NotReady(id, t);
        if (block.timestamp > t + GRACE_PERIOD) revert OperationStale(id);
        delete readyAt[id];

        // `data` is one of the four factory calls a queue function encoded (the id commits to it).
        // forge-lint: disable-next-line(low-level-calls)
        (bool ok, bytes memory ret) = factory.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        emit OperationExecuted(id, nonce, msg.sender);
    }

    // ------------------------------------------------------------------------------------------
    // Immediate
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ITemplateTimelock
    function setCreationPaused(bool paused) external onlyProposer {
        IHunchBookFactory(factory).setCreationPaused(paused);
        emit CreationPauseSet(paused);
    }

    /// @inheritdoc ITemplateTimelock
    function setGraduationPaused(bool paused) external onlyProposer {
        IHunchBookFactory(factory).setGraduationPaused(paused);
        emit GraduationPauseSet(paused);
    }

    /// @inheritdoc ITemplateTimelock
    function acceptGuardian() external {
        IHunchBookFactory(factory).acceptGuardian();
        emit GuardianAccepted();
    }

    // ------------------------------------------------------------------------------------------
    // Views and internal
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ITemplateTimelock
    function operationId(bytes calldata data, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(data, nonce));
    }

    function _queue(bytes memory data) internal returns (bytes32 id) {
        uint256 nonce = operationCount++;
        id = keccak256(abi.encode(data, nonce));
        uint256 t = block.timestamp + delay;
        readyAt[id] = t;
        // The first four bytes of the call: the factory function it runs.
        // forge-lint: disable-next-line(unsafe-typecast)
        emit OperationQueued(id, nonce, bytes4(data), data, t);
    }
}
