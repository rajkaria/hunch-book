// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "solady/utils/EIP712.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";

/// @title ReferralRegistry
/// @notice Who referred whom, for how long (roadmap C-8). See IReferralRegistry and docs/PERIPHERY.md.
/// No owner, no funds, no way to change or end someone else's binding.
contract ReferralRegistry is IReferralRegistry, EIP712 {
    /// @inheritdoc IReferralRegistry
    bytes32 public constant BIND_TYPEHASH =
        keccak256("Bind(address user,address referrer,uint256 nonce,uint256 deadline)");
    /// Longest binding the constructor accepts: 10 years.
    uint256 public constant MAX_DURATION = 3650 days;

    /// @inheritdoc IReferralRegistry
    uint256 public immutable DURATION;
    uint64 internal immutable _duration;

    struct Binding {
        address referrer;
        uint64 boundAt;
    }

    mapping(address user => Binding) internal _bindings;
    /// @inheritdoc IReferralRegistry
    mapping(address user => uint256) public nonces;

    /// @param duration Seconds a binding lasts from the moment it is made (for example 180 days).
    constructor(uint256 duration) {
        if (duration == 0 || duration > MAX_DURATION) revert BadDuration();
        DURATION = duration;
        // forge-lint: disable-next-line(unsafe-typecast)
        _duration = uint64(duration); // at most MAX_DURATION
    }

    /// @inheritdoc IReferralRegistry
    function bind(address referrer) external {
        _bind(msg.sender, referrer);
    }

    /// @inheritdoc IReferralRegistry
    function bindFor(address user, address referrer, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (user == address(0)) revert ZeroAddress();
        bytes32 digest = bindDigest(user, referrer, nonces[user], deadline);
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(user, digest, signature)) revert InvalidSignature();
        ++nonces[user];
        _bind(user, referrer);
    }

    /// @inheritdoc IReferralRegistry
    function referrerOf(address user) external view returns (address) {
        Binding memory b = _bindings[user];
        return _active(b) ? b.referrer : address(0);
    }

    /// @inheritdoc IReferralRegistry
    function bindingOf(address user)
        external
        view
        returns (address referrer, uint64 boundAt, uint64 expiresAt, bool active)
    {
        Binding memory b = _bindings[user];
        if (b.referrer == address(0)) return (address(0), 0, 0, false);
        return (b.referrer, b.boundAt, _expiry(b), _active(b));
    }

    /// @inheritdoc IReferralRegistry
    function bindDigest(address user, address referrer, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(BIND_TYPEHASH, user, referrer, nonce, deadline)));
    }

    function _bind(address user, address referrer) internal {
        if (referrer == address(0)) revert ZeroAddress();
        if (referrer == user) revert SelfReferral();
        Binding memory current = _bindings[user];
        if (_active(current)) revert AlreadyBound(current.referrer, _expiry(current));

        uint64 boundAt = SafeCastLib.toUint64(block.timestamp);
        _bindings[user] = Binding({referrer: referrer, boundAt: boundAt});
        emit Bound(user, referrer, boundAt, boundAt + _duration, msg.sender);
    }

    function _expiry(Binding memory b) internal view returns (uint64) {
        return b.boundAt + _duration;
    }

    function _active(Binding memory b) internal view returns (bool) {
        return b.referrer != address(0) && block.timestamp < _expiry(b);
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("Hunch Book Referrals", "1");
    }
}
