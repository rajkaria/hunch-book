// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {MerkleTreeLib} from "solady/utils/MerkleTreeLib.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {MerkleDistributor} from "../../src/periphery/MerkleDistributor.sol";
import {IMerkleDistributor} from "../../src/periphery/interfaces/IMerkleDistributor.sol";
import {MerkleHelper} from "./mocks/MerkleHelper.sol";

/// Delivers one unit less than sent on transferFrom.
contract FeeToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Fee";
    }

    function symbol() public pure override returns (string memory) {
        return "FEE";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        _burn(to, 1);
        return true;
    }
}

contract MerkleDistributorTest is Test {
    MerkleDistributor internal dist;
    TestUSDC internal usdc;
    address internal funder = makeAddr("funder");
    address internal relayer = makeAddr("relayer");
    address[] internal accounts;
    uint256[] internal amounts;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new TestUSDC();
        dist = new MerkleDistributor(funder);
        for (uint256 i; i < 5; ++i) {
            accounts.push(makeAddr(string.concat("account", vm.toString(i))));
            amounts.push((i + 1) * 10e6);
        }
        usdc.mint(funder, 10_000e6);
        vm.prank(funder);
        usdc.approve(address(dist), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _leaves(uint256 epoch, address[] memory accts, uint256[] memory amts)
        internal
        view
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](accts.length);
        for (uint256 i; i < accts.length; ++i) {
            leaves[i] = dist.leaf(epoch, accts[i], amts[i]);
        }
    }

    function _total(uint256[] memory amts) internal pure returns (uint256 t) {
        for (uint256 i; i < amts.length; ++i) {
            t += amts[i];
        }
    }

    /// Creates the next epoch for `accounts`/`amounts` funded with exactly their sum.
    function _epoch() internal returns (uint256 epoch, bytes32[] memory leaves) {
        epoch = dist.nextEpoch();
        leaves = _leaves(epoch, accounts, amounts);
        vm.prank(funder);
        dist.createEpoch(address(usdc), MerkleHelper.root(leaves), _total(amounts), _deadline());
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 30 days);
    }

    function _claim(uint256 epoch, bytes32[] memory leaves, uint256 i) internal {
        bytes32[] memory p = MerkleHelper.proof(leaves, i);
        vm.prank(relayer);
        dist.claim(epoch, accounts[i], amounts[i], p);
    }

    // ---------------------------------------------------------------- funder

    function test_constructor() public {
        assertEq(dist.funder(), funder);
        assertEq(dist.MIN_CLAIM_WINDOW(), 7 days);
        assertEq(dist.nextEpoch(), 1);
        vm.expectRevert(IMerkleDistributor.ZeroAddress.selector);
        new MerkleDistributor(address(0));
    }

    function test_createEpoch() public {
        bytes32 root = keccak256("root");
        vm.expectEmit(address(dist));
        emit IMerkleDistributor.EpochCreated(1, address(usdc), root, 150e6, _deadline());
        vm.prank(funder);
        uint256 epoch = dist.createEpoch(address(usdc), root, 150e6, _deadline());
        assertEq(epoch, 1);
        assertEq(dist.epochCount(), 1);
        assertEq(dist.nextEpoch(), 2);
        IMerkleDistributor.Epoch memory e = dist.epochs(1);
        assertEq(e.token, address(usdc));
        assertEq(e.root, root);
        assertEq(e.total, 150e6);
        assertEq(e.claimed, 0);
        assertEq(e.claimDeadline, _deadline());
        assertFalse(e.swept);
        assertEq(dist.outstanding(address(usdc)), 150e6);
        assertEq(usdc.balanceOf(address(dist)), 150e6);
    }

    function test_createEpoch_reverts() public {
        vm.expectRevert(IMerkleDistributor.OnlyFunder.selector);
        dist.createEpoch(address(usdc), bytes32("r"), 1, _deadline());

        vm.startPrank(funder);
        vm.expectRevert(IMerkleDistributor.ZeroAddress.selector);
        dist.createEpoch(address(0), bytes32("r"), 1, _deadline());
        vm.expectRevert(IMerkleDistributor.ZeroRoot.selector);
        dist.createEpoch(address(usdc), bytes32(0), 1, _deadline());
        vm.expectRevert(IMerkleDistributor.ZeroAmount.selector);
        dist.createEpoch(address(usdc), bytes32("r"), 0, _deadline());
        uint256 earliest = block.timestamp + 7 days;
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.DeadlineTooSoon.selector, earliest));
        dist.createEpoch(address(usdc), bytes32("r"), 1, uint64(earliest - 1));
        vm.expectRevert(IMerkleDistributor.AmountTooLarge.selector);
        dist.createEpoch(address(usdc), bytes32("r"), uint256(type(uint128).max) + 1, _deadline());
        dist.createEpoch(address(usdc), bytes32("r"), 1, uint64(earliest)); // exactly the minimum window

        FeeToken fee = new FeeToken();
        fee.mint(funder, 100);
        fee.approve(address(dist), 100);
        vm.expectRevert(IMerkleDistributor.FeeOnTransfer.selector);
        dist.createEpoch(address(fee), bytes32("r"), 100, _deadline());
        vm.stopPrank();
    }

    function test_funderTransfer_twoStep() public {
        address next = makeAddr("next funder");
        vm.expectRevert(IMerkleDistributor.OnlyFunder.selector);
        dist.transferFunder(next);

        vm.expectEmit(address(dist));
        emit IMerkleDistributor.FunderTransferStarted(funder, next);
        vm.prank(funder);
        dist.transferFunder(next);
        assertEq(dist.pendingFunder(), next);
        assertEq(dist.funder(), funder, "unchanged until accepted");

        vm.expectRevert(IMerkleDistributor.OnlyPendingFunder.selector);
        dist.acceptFunder();

        vm.expectEmit(address(dist));
        emit IMerkleDistributor.FunderTransferred(funder, next);
        vm.prank(next);
        dist.acceptFunder();
        assertEq(dist.funder(), next);
        assertEq(dist.pendingFunder(), address(0));

        vm.prank(funder);
        vm.expectRevert(IMerkleDistributor.OnlyFunder.selector);
        dist.transferFunder(funder);
    }

    // ---------------------------------------------------------------- claims

    function test_claim_paysTheAccountNotTheCaller() public {
        (uint256 epoch, bytes32[] memory leaves) = _epoch();
        bytes32[] memory p = MerkleHelper.proof(leaves, 2);
        vm.expectEmit(address(dist));
        emit IMerkleDistributor.Claimed(epoch, accounts[2], 30e6, relayer);
        vm.prank(relayer);
        dist.claim(epoch, accounts[2], 30e6, p);
        assertEq(usdc.balanceOf(accounts[2]), 30e6);
        assertEq(usdc.balanceOf(relayer), 0);
        assertTrue(dist.isClaimed(epoch, accounts[2]));
        assertEq(dist.epochs(epoch).claimed, 30e6);
        assertEq(dist.outstanding(address(usdc)), 120e6);
    }

    function test_claim_everyLeafOnce() public {
        (uint256 epoch, bytes32[] memory leaves) = _epoch();
        for (uint256 i; i < accounts.length; ++i) {
            _claim(epoch, leaves, i);
            assertEq(usdc.balanceOf(accounts[i]), amounts[i]);
        }
        assertEq(usdc.balanceOf(address(dist)), 0);
        assertEq(dist.outstanding(address(usdc)), 0);

        bytes32[] memory p = MerkleHelper.proof(leaves, 0);
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.AlreadyClaimed.selector, epoch, accounts[0]));
        dist.claim(epoch, accounts[0], amounts[0], p);
    }

    function test_claim_rejectsForgedClaims() public {
        (uint256 epoch, bytes32[] memory leaves) = _epoch();
        bytes32[] memory p = MerkleHelper.proof(leaves, 1);

        vm.expectRevert(IMerkleDistributor.InvalidProof.selector);
        dist.claim(epoch, accounts[1], amounts[1] + 1, p); // more than the leaf
        vm.expectRevert(IMerkleDistributor.InvalidProof.selector);
        dist.claim(epoch, accounts[0], amounts[1], p); // someone else's leaf
        vm.expectRevert(IMerkleDistributor.InvalidProof.selector);
        dist.claim(epoch, accounts[1], amounts[1], new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.UnknownEpoch.selector, 9));
        dist.claim(9, accounts[1], amounts[1], p);
        vm.expectRevert(IMerkleDistributor.ZeroAddress.selector);
        dist.claim(epoch, address(0), amounts[1], p);
        vm.expectRevert(IMerkleDistributor.ZeroAmount.selector);
        dist.claim(epoch, accounts[1], 0, p);

        // The same tree replayed as a later epoch: the leaves commit to the epoch id.
        vm.prank(funder);
        uint256 epoch2 = dist.createEpoch(address(usdc), MerkleHelper.root(leaves), _total(amounts), _deadline());
        vm.expectRevert(IMerkleDistributor.InvalidProof.selector);
        dist.claim(epoch2, accounts[1], amounts[1], p);
    }

    function test_claim_closesAtTheDeadline() public {
        (uint256 epoch, bytes32[] memory leaves) = _epoch();
        vm.warp(_deadlineOf(epoch));
        _claim(epoch, leaves, 0); // the deadline itself is still open
        vm.warp(_deadlineOf(epoch) + 1);
        bytes32[] memory p = MerkleHelper.proof(leaves, 1);
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.ClaimWindowClosed.selector, epoch));
        dist.claim(epoch, accounts[1], amounts[1], p);
    }

    function _deadlineOf(uint256 epoch) internal view returns (uint256) {
        return dist.epochs(epoch).claimDeadline;
    }

    /// A root whose leaves add up to more than the epoch's total pays out until the total, then stops:
    /// it can never reach another epoch's tokens.
    function test_claim_cannotExceedTheEpochTotal() public {
        (uint256 good,) = _epoch(); // 150 USDC for others, in the same contract
        uint256 epoch = dist.nextEpoch();
        bytes32[] memory leaves = _leaves(epoch, accounts, amounts);
        vm.prank(funder);
        dist.createEpoch(address(usdc), MerkleHelper.root(leaves), 50e6, _deadline());

        _claim(epoch, leaves, 0); // 10
        _claim(epoch, leaves, 3); // 40 -> 50, the whole total
        bytes32[] memory p = MerkleHelper.proof(leaves, 1);
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.ExceedsTotal.selector, epoch));
        dist.claim(epoch, accounts[1], amounts[1], p);
        assertEq(usdc.balanceOf(address(dist)), 150e6, "the other epoch is intact");
        assertEq(dist.outstanding(address(usdc)), 150e6);
        good;
    }

    function test_claimMany_acrossEpochs() public {
        (uint256 e1, bytes32[] memory l1) = _epoch();
        (uint256 e2, bytes32[] memory l2) = _epoch();
        IMerkleDistributor.Claim[] memory cs = new IMerkleDistributor.Claim[](3);
        cs[0] = IMerkleDistributor.Claim(e1, accounts[0], amounts[0], MerkleHelper.proof(l1, 0));
        cs[1] = IMerkleDistributor.Claim(e2, accounts[0], amounts[0], MerkleHelper.proof(l2, 0));
        cs[2] = IMerkleDistributor.Claim(e2, accounts[4], amounts[4], MerkleHelper.proof(l2, 4));
        dist.claimMany(cs);
        assertEq(usdc.balanceOf(accounts[0]), 2 * amounts[0]);
        assertEq(usdc.balanceOf(accounts[4]), amounts[4]);

        // All or nothing.
        cs[0] = IMerkleDistributor.Claim(e1, accounts[1], amounts[1], MerkleHelper.proof(l1, 1));
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.AlreadyClaimed.selector, e2, accounts[0]));
        dist.claimMany(cs);
        assertFalse(dist.isClaimed(e1, accounts[1]));
    }

    // ---------------------------------------------------------------- sweep

    function test_sweep_onlyTheRemainderAfterTheDeadline() public {
        (uint256 epoch, bytes32[] memory leaves) = _epoch();
        _claim(epoch, leaves, 4); // 50 of 150
        address treasury = makeAddr("treasury");

        vm.expectRevert(IMerkleDistributor.OnlyFunder.selector);
        dist.sweep(epoch, treasury);
        vm.startPrank(funder);
        vm.warp(_deadlineOf(epoch));
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.ClaimWindowOpen.selector, epoch));
        dist.sweep(epoch, treasury);
        vm.warp(_deadlineOf(epoch) + 1);
        vm.expectRevert(IMerkleDistributor.ZeroAddress.selector);
        dist.sweep(epoch, address(0));
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.UnknownEpoch.selector, 7));
        dist.sweep(7, treasury);

        vm.expectEmit(address(dist));
        emit IMerkleDistributor.Swept(epoch, treasury, 100e6);
        assertEq(dist.sweep(epoch, treasury), 100e6);
        assertEq(usdc.balanceOf(treasury), 100e6);
        assertTrue(dist.epochs(epoch).swept);
        assertEq(dist.outstanding(address(usdc)), 0);
        vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.AlreadySwept.selector, epoch));
        dist.sweep(epoch, treasury);
        vm.stopPrank();
    }

    function test_sweep_fullyClaimedEpochSweepsNothing() public {
        (uint256 epoch, bytes32[] memory leaves) = _epoch();
        for (uint256 i; i < accounts.length; ++i) {
            _claim(epoch, leaves, i);
        }
        vm.warp(_deadlineOf(epoch) + 1);
        vm.prank(funder);
        assertEq(dist.sweep(epoch, funder), 0);
    }

    // ---------------------------------------------------------------- tree format

    /// Trees built with solady's MerkleTreeLib (OpenZeppelin's StandardMerkleTree layout) verify too.
    function test_standardTreeLayoutVerifies() public {
        uint256 epoch = dist.nextEpoch();
        bytes32[] memory leaves = _leaves(epoch, accounts, amounts);
        bytes32[] memory tree = MerkleTreeLib.build(leaves);
        vm.prank(funder);
        dist.createEpoch(address(usdc), MerkleTreeLib.root(tree), _total(amounts), _deadline());
        for (uint256 i; i < leaves.length; ++i) {
            dist.claim(epoch, accounts[i], amounts[i], MerkleTreeLib.leafProof(tree, i));
        }
        assertEq(usdc.balanceOf(address(dist)), 0);
    }

    function test_leafFormat() public view {
        assertEq(
            dist.leaf(3, accounts[0], 7e6),
            keccak256(bytes.concat(keccak256(abi.encode(uint256(3), accounts[0], uint256(7e6)))))
        );
    }

    // ---------------------------------------------------------------- fuzz

    /// Any tree: every leaf claims exactly once for exactly its amount, and the epoch empties out.
    function testFuzz_everyLeafClaimsOnce(uint256 seed, uint256 n) public {
        n = bound(n, 1, 40);
        uint256 epoch = dist.nextEpoch();
        address[] memory accts = new address[](n);
        uint256[] memory amts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            accts[i] = address(uint160(uint256(keccak256(abi.encode(seed, i))) | 1));
            amts[i] = 1 + uint256(keccak256(abi.encode(seed, i, "amount"))) % 200e6;
        }
        bytes32[] memory leaves = _leaves(epoch, accts, amts);
        uint256 total = _total(amts);
        usdc.mint(funder, 10_000e6);
        vm.prank(funder);
        dist.createEpoch(address(usdc), MerkleHelper.root(leaves), total, _deadline());

        for (uint256 j; j < n; ++j) {
            uint256 i = (j + seed % n) % n; // claim in a rotated order
            if (dist.isClaimed(epoch, accts[i])) continue; // a repeated address
            bytes32[] memory p = MerkleHelper.proof(leaves, i);
            uint256 before = usdc.balanceOf(accts[i]);
            dist.claim(epoch, accts[i], amts[i], p);
            assertEq(usdc.balanceOf(accts[i]) - before, amts[i]);
            vm.expectRevert(abi.encodeWithSelector(IMerkleDistributor.AlreadyClaimed.selector, epoch, accts[i]));
            dist.claim(epoch, accts[i], amts[i], p);
        }
        assertEq(dist.epochs(epoch).claimed, total);
        assertEq(usdc.balanceOf(address(dist)), 0);
    }

    /// A proof never verifies for a different amount or account.
    function testFuzz_forgedLeafFails(uint256 i, uint256 amount, address account) public {
        (uint256 epoch, bytes32[] memory leaves) = _epoch();
        i = bound(i, 0, accounts.length - 1);
        vm.assume(account != address(0));
        amount = bound(amount, 1, type(uint128).max);
        vm.assume(account != accounts[i] || amount != amounts[i]);
        bytes32[] memory p = MerkleHelper.proof(leaves, i);
        vm.expectRevert(IMerkleDistributor.InvalidProof.selector);
        dist.claim(epoch, account, amount, p);
    }
}
