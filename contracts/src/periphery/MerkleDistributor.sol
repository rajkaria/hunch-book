// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IMerkleDistributor} from "./interfaces/IMerkleDistributor.sol";

/// @title MerkleDistributor
/// @notice Epoch payouts for referral shares and maker rewards. See IMerkleDistributor and
/// docs/PERIPHERY.md.
///
/// Accounting, per epoch: claimed + swept <= total, and `outstanding[token]` (the sum over unswept
/// epochs of total - claimed) never exceeds this contract's balance of `token`. Each epoch is
/// funded in full when created (the transfer is measured, so fee-on-transfer tokens are refused),
/// and a claim that would push an epoch past its total reverts, so a bad root can never reach
/// another epoch's funds. The funder cannot touch an epoch before its deadline, and after it only
/// the unclaimed remainder.
contract MerkleDistributor is IMerkleDistributor {
    using SafeTransferLib for address;

    /// @inheritdoc IMerkleDistributor
    uint256 public constant MIN_CLAIM_WINDOW = 7 days;

    /// @inheritdoc IMerkleDistributor
    address public funder;
    /// @inheritdoc IMerkleDistributor
    address public pendingFunder;
    /// @inheritdoc IMerkleDistributor
    uint256 public epochCount;
    /// @inheritdoc IMerkleDistributor
    mapping(address token => uint256) public outstanding;

    mapping(uint256 epoch => Epoch) internal _epochs;
    mapping(uint256 epoch => mapping(address account => bool)) internal _claimed;

    bool private transient _locked;

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyFunder() {
        if (msg.sender != funder) revert OnlyFunder();
        _;
    }

    /// @param funder_ Creates epochs and sweeps expired ones (for example the protocol fee recipient).
    constructor(address funder_) {
        if (funder_ == address(0)) revert ZeroAddress();
        funder = funder_;
        emit FunderTransferred(address(0), funder_);
    }

    // ------------------------------------------------------------------------------------------
    // Funder
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMerkleDistributor
    function createEpoch(address token, bytes32 root, uint256 total, uint64 claimDeadline)
        external
        nonReentrant
        onlyFunder
        returns (uint256 epoch)
    {
        if (token == address(0)) revert ZeroAddress();
        if (root == bytes32(0)) revert ZeroRoot();
        if (total == 0) revert ZeroAmount();
        if (claimDeadline < block.timestamp + MIN_CLAIM_WINDOW) {
            revert DeadlineTooSoon(block.timestamp + MIN_CLAIM_WINDOW);
        }
        if (total > type(uint128).max) revert AmountTooLarge();

        epoch = ++epochCount;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 total128 = uint128(total); // checked above
        _epochs[epoch] =
            Epoch({token: token, claimDeadline: claimDeadline, swept: false, root: root, total: total128, claimed: 0});
        outstanding[token] += total;

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), total);
        // Exactly `total` must arrive: a token that delivers less would leave the epoch underfunded.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (token.balanceOf(address(this)) - before != total) revert FeeOnTransfer();
        emit EpochCreated(epoch, token, root, total, claimDeadline);
    }

    /// @inheritdoc IMerkleDistributor
    function sweep(uint256 epoch, address to) external nonReentrant onlyFunder returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        Epoch storage e = _epoch(epoch);
        if (block.timestamp <= e.claimDeadline) revert ClaimWindowOpen(epoch);
        if (e.swept) revert AlreadySwept(epoch);
        e.swept = true;
        amount = uint256(e.total) - e.claimed;
        address token = e.token;
        outstanding[token] -= amount;
        if (amount != 0) token.safeTransfer(to, amount);
        emit Swept(epoch, to, amount);
    }

    /// @inheritdoc IMerkleDistributor
    function transferFunder(address pending) external onlyFunder {
        pendingFunder = pending;
        emit FunderTransferStarted(funder, pending);
    }

    /// @inheritdoc IMerkleDistributor
    function acceptFunder() external {
        if (msg.sender != pendingFunder) revert OnlyPendingFunder();
        emit FunderTransferred(funder, msg.sender);
        funder = msg.sender;
        pendingFunder = address(0);
    }

    // ------------------------------------------------------------------------------------------
    // Anyone
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMerkleDistributor
    function claim(uint256 epoch, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _claim(epoch, account, amount, proof);
    }

    /// @inheritdoc IMerkleDistributor
    function claimMany(Claim[] calldata claims) external nonReentrant {
        for (uint256 i; i < claims.length; ++i) {
            Claim calldata c = claims[i];
            _claim(c.epoch, c.account, c.amount, c.proof);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMerkleDistributor
    function epochs(uint256 epoch) external view returns (Epoch memory) {
        return _epochs[epoch];
    }

    /// @inheritdoc IMerkleDistributor
    function isClaimed(uint256 epoch, address account) external view returns (bool) {
        return _claimed[epoch][account];
    }

    /// @inheritdoc IMerkleDistributor
    function leaf(uint256 epoch, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, account, amount))));
    }

    /// @inheritdoc IMerkleDistributor
    function nextEpoch() external view returns (uint256) {
        return epochCount + 1;
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    function _claim(uint256 epoch, address account, uint256 amount, bytes32[] calldata proof) internal {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        Epoch storage e = _epoch(epoch);
        if (block.timestamp > e.claimDeadline) revert ClaimWindowClosed(epoch);
        if (_claimed[epoch][account]) revert AlreadyClaimed(epoch, account);
        if (!MerkleProofLib.verifyCalldata(proof, e.root, leaf(epoch, account, amount))) revert InvalidProof();

        uint256 claimed = uint256(e.claimed) + amount;
        if (claimed > e.total) revert ExceedsTotal(epoch);
        _claimed[epoch][account] = true;
        // forge-lint: disable-next-line(unsafe-typecast)
        e.claimed = uint128(claimed); // <= total, which fits in uint128
        address token = e.token;
        outstanding[token] -= amount;

        token.safeTransfer(account, amount);
        emit Claimed(epoch, account, amount, msg.sender);
    }

    function _epoch(uint256 epoch) internal view returns (Epoch storage e) {
        e = _epochs[epoch];
        if (e.token == address(0)) revert UnknownEpoch(epoch);
    }
}
