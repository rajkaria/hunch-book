// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Epoch payouts from Merkle roots (roadmap C-8 referral shares and V-5 maker rewards,
/// docs/PERIPHERY.md). The funder deposits each epoch's full total up front; anyone can submit a
/// claim, and the tokens always go to the account in the leaf. After an epoch's claim deadline the
/// funder can take back only that epoch's unclaimed remainder.
///
/// Leaf = keccak256(bytes.concat(keccak256(abi.encode(epoch, account, amount)))), the OpenZeppelin
/// StandardMerkleTree format with values (uint256 epoch, address account, uint256 amount). Pairs are
/// hashed sorted. One leaf per account per epoch.
interface IMerkleDistributor {
    struct Epoch {
        address token;
        uint64 claimDeadline; // unix seconds, inclusive
        bool swept;
        bytes32 root;
        uint128 total;
        uint128 claimed;
    }

    /// One claim for `claimMany`.
    struct Claim {
        uint256 epoch;
        address account;
        uint256 amount;
        bytes32[] proof;
    }

    event EpochCreated(uint256 indexed epoch, address indexed token, bytes32 root, uint256 total, uint64 claimDeadline);
    event Claimed(uint256 indexed epoch, address indexed account, uint256 amount, address indexed caller);
    event Swept(uint256 indexed epoch, address indexed to, uint256 amount);
    event FunderTransferStarted(address indexed current, address indexed pending);
    event FunderTransferred(address indexed previous, address indexed current);

    error OnlyFunder();
    error OnlyPendingFunder();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroRoot();
    error DeadlineTooSoon(uint256 earliest);
    error AmountTooLarge();
    error FeeOnTransfer();
    error UnknownEpoch(uint256 epoch);
    error ClaimWindowClosed(uint256 epoch);
    error ClaimWindowOpen(uint256 epoch);
    error AlreadyClaimed(uint256 epoch, address account);
    error AlreadySwept(uint256 epoch);
    error InvalidProof();
    error ExceedsTotal(uint256 epoch);
    error Reentrancy();

    /// Funder only. Pulls `total` of `token` from the funder and opens epoch `nextEpoch()` with `root`.
    /// `claimDeadline` must be at least `MIN_CLAIM_WINDOW` from now. Build the tree with the epoch id
    /// that `nextEpoch()` returns. Returns the new epoch id.
    function createEpoch(address token, bytes32 root, uint256 total, uint64 claimDeadline)
        external
        returns (uint256 epoch);

    /// Pays `amount` to `account` for `epoch` if `proof` shows the leaf is in the epoch's root. Anyone
    /// can submit it. Each account claims once per epoch, up to the deadline.
    function claim(uint256 epoch, address account, uint256 amount, bytes32[] calldata proof) external;

    /// Several claims in one call. Reverts if any one of them fails.
    function claimMany(Claim[] calldata claims) external;

    /// Funder only, after the epoch's deadline. Sends the unclaimed remainder to `to`; once per epoch.
    function sweep(uint256 epoch, address to) external returns (uint256 amount);

    /// Funder only. Starts a two-step transfer of the funder role; `pending` must accept.
    function transferFunder(address pending) external;

    /// Completes the funder transfer. Only the pending funder.
    function acceptFunder() external;

    function epochs(uint256 epoch) external view returns (Epoch memory);
    function isClaimed(uint256 epoch, address account) external view returns (bool);
    /// The leaf for (epoch, account, amount).
    function leaf(uint256 epoch, address account, uint256 amount) external pure returns (bytes32);
    function epochCount() external view returns (uint256);
    /// The id the next `createEpoch` will use.
    function nextEpoch() external view returns (uint256);
    /// Tokens still owed to claimants across open (unswept) epochs.
    function outstanding(address token) external view returns (uint256);
    function funder() external view returns (address);
    function pendingFunder() external view returns (address);
    function MIN_CLAIM_WINDOW() external view returns (uint256);
}
