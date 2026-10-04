// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Referral bindings (roadmap C-8, docs/PERIPHERY.md). A user binds to a referrer once; the binding
/// lasts `DURATION` seconds from the moment it is made. Purely a registry: it holds no funds and pays
/// nothing. Referral shares are computed offchain from indexed fee events while a binding is active,
/// and paid through the MerkleDistributor.
interface IReferralRegistry {
    /// `user` is bound to `referrer` from `boundAt` until `expiresAt` (exclusive). `relayer` is the
    /// address that submitted the binding (the user itself for `bind`).
    event Bound(
        address indexed user, address indexed referrer, uint64 boundAt, uint64 expiresAt, address indexed relayer
    );

    error ZeroAddress();
    error SelfReferral();
    error AlreadyBound(address referrer, uint64 expiresAt);
    error SignatureExpired();
    error InvalidSignature();
    error BadDuration();

    /// Binds the caller to `referrer`. Reverts while the caller has an active binding, for the zero
    /// address, and for a self-referral. After a binding expires the user may bind again.
    function bind(address referrer) external;

    /// Binds `user` to `referrer` on the user's EIP-712 signature (type `Bind`, see `BIND_TYPEHASH`), so
    /// a relayer can pay the gas for a passkey or new account. Smart accounts sign through ERC-1271.
    /// Each signature carries the user's current nonce and can be used once.
    function bindFor(address user, address referrer, uint256 deadline, bytes calldata signature) external;

    /// The user's referrer while the binding is active; the zero address before binding and after expiry.
    function referrerOf(address user) external view returns (address);

    /// The user's latest binding, active or not.
    function bindingOf(address user)
        external
        view
        returns (address referrer, uint64 boundAt, uint64 expiresAt, bool active);

    /// The EIP-712 digest a user signs for `bindFor`.
    function bindDigest(address user, address referrer, uint256 nonce, uint256 deadline) external view returns (bytes32);

    /// How long a binding lasts, in seconds.
    function DURATION() external view returns (uint256);
    /// keccak256("Bind(address user,address referrer,uint256 nonce,uint256 deadline)")
    function BIND_TYPEHASH() external view returns (bytes32);
    function nonces(address user) external view returns (uint256);
}
