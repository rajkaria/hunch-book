// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {ReferralRegistry} from "../../src/periphery/ReferralRegistry.sol";
import {IReferralRegistry} from "../../src/periphery/interfaces/IReferralRegistry.sol";

/// A smart account that accepts signatures from one owner key (ERC-1271).
contract MockSmartAccount {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recoverCalldata(hash, signature) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract ReferralRegistryTest is Test {
    uint256 internal constant DURATION = 180 days;

    ReferralRegistry internal reg;
    address internal user;
    uint256 internal userKey;
    address internal referrer = makeAddr("referrer");
    address internal other = makeAddr("other referrer");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new ReferralRegistry(DURATION);
        (user, userKey) = makeAddrAndKey("user");
    }

    function _sign(uint256 key, address u, address r, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, reg.bindDigest(u, r, nonce, deadline));
        return abi.encodePacked(rr, s, v);
    }

    // ---------------------------------------------------------------- construction

    function test_constructor() public view {
        assertEq(reg.DURATION(), DURATION);
        assertEq(reg.BIND_TYPEHASH(), keccak256("Bind(address user,address referrer,uint256 nonce,uint256 deadline)"));
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = reg.eip712Domain();
        assertEq(name, "Hunch Book Referrals");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(reg));
    }

    function test_constructor_badDuration() public {
        vm.expectRevert(IReferralRegistry.BadDuration.selector);
        new ReferralRegistry(0);
        vm.expectRevert(IReferralRegistry.BadDuration.selector);
        new ReferralRegistry(3651 days);
        new ReferralRegistry(3650 days);
    }

    // ---------------------------------------------------------------- bind

    function test_bind() public {
        uint64 nowTs = uint64(block.timestamp);
        vm.expectEmit(address(reg));
        emit IReferralRegistry.Bound(user, referrer, nowTs, nowTs + uint64(DURATION), user);
        vm.prank(user);
        reg.bind(referrer);

        assertEq(reg.referrerOf(user), referrer);
        (address r, uint64 boundAt, uint64 expiresAt, bool active) = reg.bindingOf(user);
        assertEq(r, referrer);
        assertEq(boundAt, nowTs);
        assertEq(expiresAt, nowTs + DURATION);
        assertTrue(active);
    }

    function test_bind_reverts() public {
        vm.startPrank(user);
        vm.expectRevert(IReferralRegistry.ZeroAddress.selector);
        reg.bind(address(0));
        vm.expectRevert(IReferralRegistry.SelfReferral.selector);
        reg.bind(user);
        reg.bind(referrer);
        uint64 expiry = uint64(block.timestamp + DURATION);
        vm.expectRevert(abi.encodeWithSelector(IReferralRegistry.AlreadyBound.selector, referrer, expiry));
        reg.bind(other);
        vm.expectRevert(abi.encodeWithSelector(IReferralRegistry.AlreadyBound.selector, referrer, expiry));
        reg.bind(referrer);
        vm.stopPrank();
    }

    function test_binding_expiresThenCanRebind() public {
        vm.prank(user);
        reg.bind(referrer);
        vm.warp(block.timestamp + DURATION - 1);
        assertEq(reg.referrerOf(user), referrer, "active until the last second");

        vm.warp(block.timestamp + 1);
        assertEq(reg.referrerOf(user), address(0), "expired");
        (address r,,, bool active) = reg.bindingOf(user);
        assertEq(r, referrer, "the record stays readable");
        assertFalse(active);

        vm.prank(user);
        reg.bind(other);
        assertEq(reg.referrerOf(user), other);
    }

    function test_unbound() public view {
        assertEq(reg.referrerOf(user), address(0));
        (address r, uint64 boundAt, uint64 expiresAt, bool active) = reg.bindingOf(user);
        assertEq(r, address(0));
        assertEq(boundAt, 0);
        assertEq(expiresAt, 0);
        assertFalse(active);
    }

    // ---------------------------------------------------------------- bindFor

    function test_bindFor_relayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(userKey, user, referrer, 0, deadline);
        vm.expectEmit(address(reg));
        emit IReferralRegistry.Bound(
            user, referrer, uint64(block.timestamp), uint64(block.timestamp + DURATION), relayer
        );
        vm.prank(relayer);
        reg.bindFor(user, referrer, deadline, sig);
        assertEq(reg.referrerOf(user), referrer);
        assertEq(reg.nonces(user), 1);
    }

    function test_bindFor_rejectsBadSignatures() public {
        uint256 deadline = block.timestamp + 1 hours;
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes memory byStranger = _sign(strangerKey, user, referrer, 0, deadline);
        bytes memory forReferrer = _sign(userKey, user, referrer, 0, deadline);
        bytes memory wrongNonce = _sign(userKey, user, referrer, 1, deadline);
        vm.startPrank(relayer);

        vm.expectRevert(IReferralRegistry.InvalidSignature.selector);
        reg.bindFor(user, referrer, deadline, byStranger);

        // Signed for one referrer: a relayer cannot redirect it to another.
        vm.expectRevert(IReferralRegistry.InvalidSignature.selector);
        reg.bindFor(user, other, deadline, forReferrer);

        vm.expectRevert(IReferralRegistry.InvalidSignature.selector);
        reg.bindFor(user, referrer, deadline, wrongNonce);

        vm.expectRevert(IReferralRegistry.InvalidSignature.selector);
        reg.bindFor(user, referrer, deadline, hex"1234");

        vm.expectRevert(IReferralRegistry.ZeroAddress.selector);
        reg.bindFor(address(0), referrer, deadline, hex"");

        vm.warp(deadline + 1);
        vm.expectRevert(IReferralRegistry.SignatureExpired.selector);
        reg.bindFor(user, referrer, deadline, forReferrer);
        vm.stopPrank();
    }

    function test_bindFor_signatureUsableOnce() public {
        uint256 deadline = block.timestamp + 400 days;
        bytes memory sig = _sign(userKey, user, referrer, 0, deadline);
        reg.bindFor(user, referrer, deadline, sig);
        vm.warp(block.timestamp + DURATION);
        // Expired binding, same signature: the nonce moved on, so it cannot bind again.
        vm.expectRevert(IReferralRegistry.InvalidSignature.selector);
        reg.bindFor(user, referrer, deadline, sig);
        bytes memory next = _sign(userKey, user, referrer, 1, deadline);
        reg.bindFor(user, referrer, deadline, next);
        assertEq(reg.nonces(user), 2);
    }

    function test_bindFor_smartAccount() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("account owner");
        MockSmartAccount account = new MockSmartAccount(owner);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(ownerKey, address(account), referrer, 0, deadline);
        reg.bindFor(address(account), referrer, deadline, sig);
        assertEq(reg.referrerOf(address(account)), referrer);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_activeExactlyForDuration(uint256 duration, uint256 elapsed) public {
        duration = bound(duration, 1, 3650 days);
        elapsed = bound(elapsed, 0, 2 * duration);
        ReferralRegistry r = new ReferralRegistry(duration);
        vm.prank(user);
        r.bind(referrer);
        vm.warp(block.timestamp + elapsed);
        assertEq(r.referrerOf(user), elapsed < duration ? referrer : address(0));
        vm.prank(user);
        if (elapsed < duration) {
            vm.expectRevert();
            r.bind(other);
        } else {
            r.bind(other);
            assertEq(r.referrerOf(user), other);
        }
    }

    function testFuzz_bindFor_onlyTheUsersKey(uint256 key, address ref) public {
        key = bound(key, 1, type(uint128).max);
        vm.assume(ref != address(0) && ref != user);
        uint256 deadline = block.timestamp + 1;
        bytes memory sig = _sign(key, user, ref, 0, deadline);
        if (key == userKey) {
            reg.bindFor(user, ref, deadline, sig);
            assertEq(reg.referrerOf(user), ref);
        } else {
            vm.expectRevert(IReferralRegistry.InvalidSignature.selector);
            reg.bindFor(user, ref, deadline, sig);
        }
    }
}
