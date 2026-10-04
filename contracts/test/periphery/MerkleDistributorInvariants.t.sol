// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TestUSDC} from "../../src/mocks/TestUSDC.sol";
import {MerkleDistributor} from "../../src/periphery/MerkleDistributor.sol";
import {IMerkleDistributor} from "../../src/periphery/interfaces/IMerkleDistributor.sol";
import {MockTokenForRouter} from "../mocks/MockVaultForRouter.sol";
import {MerkleHelper} from "./mocks/MerkleHelper.sol";

/// Random epochs (some funded below what their leaves add up to, as a bad root would be), claims by
/// anyone, double-claim attempts, sweeps and time passing, across two tokens. Tracks every token
/// paid out per epoch.
contract MerkleDistributorHandler is Test {
    MerkleDistributor internal dist;
    address internal funder;
    address[2] internal tokens;
    address[6] internal accounts;

    uint256[] public epochIds;
    mapping(uint256 epoch => address[]) internal _accts;
    mapping(uint256 epoch => uint256[]) internal _amts;
    mapping(uint256 epoch => uint256) public paidClaims;
    mapping(uint256 epoch => uint256) public paidSweep;
    mapping(address token => uint256) public funded;
    mapping(address token => uint256) public paidOut;

    uint256 public violations;
    uint256 public claims;
    uint256 public refusedOverTotal;
    uint256 public sweeps;

    constructor(MerkleDistributor d, address funder_, address t0, address t1) {
        dist = d;
        funder = funder_;
        tokens = [t0, t1];
        for (uint256 i; i < 6; ++i) {
            accounts[i] = makeAddr(string.concat("account", vm.toString(i)));
        }
    }

    function epochCount() external view returns (uint256) {
        return epochIds.length;
    }

    function totalOf(uint256 epoch) public view returns (uint256 t) {
        uint256[] storage a = _amts[epoch];
        for (uint256 i; i < a.length; ++i) {
            t += a[i];
        }
    }

    function _leaves(uint256 epoch) internal view returns (bytes32[] memory leaves) {
        address[] storage a = _accts[epoch];
        leaves = new bytes32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            leaves[i] = dist.leaf(epoch, a[i], _amts[epoch][i]);
        }
    }

    // ---- funder ----

    function createEpoch(uint256 seed, bool secondToken, uint8 n, bool underfund) external {
        uint256 epoch = dist.nextEpoch();
        uint256 count = 1 + n % 6;
        uint256 total;
        for (uint256 i; i < count; ++i) {
            _accts[epoch].push(accounts[(seed % 6 + i) % 6]);
            uint256 amount = 1 + uint256(keccak256(abi.encode(seed, i))) % 500e6;
            _amts[epoch].push(amount);
            total += amount;
        }
        // An underfunded epoch stands in for a root that promises more than was deposited.
        uint256 deposit = underfund && total > 1 ? total / 2 : total;
        address token = tokens[secondToken ? 1 : 0];
        _mint(token, funder, deposit);
        vm.startPrank(funder);
        MockTokenForRouter(token).approve(address(dist), deposit);
        dist.createEpoch(token, MerkleHelper.root(_leaves(epoch)), deposit, uint64(block.timestamp + 7 days));
        vm.stopPrank();
        epochIds.push(epoch);
        funded[token] += deposit;
    }

    function _mint(address token, address to, uint256 amount) internal {
        if (token == tokens[0]) {
            while (amount > 0) {
                uint256 m = amount > 10_000e6 ? 10_000e6 : amount;
                TestUSDC(token).mint(to, m);
                amount -= m;
            }
        } else {
            MockTokenForRouter(token).mint(to, amount);
        }
    }

    function sweep(uint256 seed) external {
        if (epochIds.length == 0) return;
        uint256 epoch = epochIds[seed % epochIds.length];
        IMerkleDistributor.Epoch memory e = dist.epochs(epoch);
        if (e.swept || block.timestamp <= e.claimDeadline) return;
        vm.prank(funder);
        uint256 amount = dist.sweep(epoch, funder);
        if (amount != uint256(e.total) - e.claimed) ++violations;
        paidSweep[epoch] += amount;
        paidOut[e.token] += amount;
        ++sweeps;
    }

    // ---- anyone ----

    function claim(uint256 seed, uint256 leafSeed, address caller) external {
        if (epochIds.length == 0) return;
        uint256 epoch = epochIds[seed % epochIds.length];
        IMerkleDistributor.Epoch memory e = dist.epochs(epoch);
        uint256 i = leafSeed % _accts[epoch].length;
        address account = _accts[epoch][i];
        uint256 amount = _amts[epoch][i];
        bytes32[] memory proof = MerkleHelper.proof(_leaves(epoch), i);
        bool open = block.timestamp <= e.claimDeadline;
        bool fresh = !dist.isClaimed(epoch, account);

        uint256 before = MockTokenForRouter(e.token).balanceOf(account);
        vm.prank(caller);
        try dist.claim(epoch, account, amount, proof) {
            // Only a fresh claim, in time, within the total, pays; and it pays the leaf's account.
            if (!open || !fresh || uint256(e.claimed) + amount > e.total) ++violations;
            if (MockTokenForRouter(e.token).balanceOf(account) - before != amount) ++violations;
            paidClaims[epoch] += amount;
            paidOut[e.token] += amount;
            ++claims;
        } catch {
            if (open && fresh && uint256(e.claimed) + amount <= e.total) ++violations;
            if (open && fresh) ++refusedOverTotal;
        }
    }

    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }
}

contract MerkleDistributorInvariantsTest is Test {
    MerkleDistributor internal dist;
    MerkleDistributorHandler internal handler;
    TestUSDC internal usdc;
    MockTokenForRouter internal other;
    address internal funder = makeAddr("funder");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new TestUSDC();
        other = new MockTokenForRouter("Reward", "RWD", 18);
        dist = new MerkleDistributor(funder);
        handler = new MerkleDistributorHandler(dist, funder, address(usdc), address(other));
        targetContract(address(handler));
    }

    /// Per epoch: claimed + swept <= total, and the contract's own counters match what moved.
    function invariant_epochsNeverPayMoreThanFunded() public view {
        uint256 n = handler.epochCount();
        for (uint256 i; i < n; ++i) {
            uint256 epoch = handler.epochIds(i);
            IMerkleDistributor.Epoch memory e = dist.epochs(epoch);
            assertLe(handler.paidClaims(epoch) + handler.paidSweep(epoch), e.total);
            assertEq(e.claimed, handler.paidClaims(epoch));
        }
        assertEq(handler.violations(), 0);
    }

    /// Per token: balance = funded - paid out, and it always covers what is still owed.
    function invariant_balanceCoversOutstanding() public view {
        address[2] memory ts = [address(usdc), address(other)];
        for (uint256 k; k < 2; ++k) {
            address t = ts[k];
            uint256 bal = MockTokenForRouter(t).balanceOf(address(dist));
            assertEq(bal, handler.funded(t) - handler.paidOut(t));
            assertGe(bal, dist.outstanding(t));
            assertEq(bal, dist.outstanding(t), "only outstanding amounts stay");
        }
    }

    /// The handler's paths all execute.
    function test_handlerReachesEveryPath() public {
        handler.createEpoch(1, false, 3, false);
        handler.createEpoch(2, true, 5, true);
        handler.claim(0, 0, address(this));
        handler.claim(0, 0, address(this)); // a double claim is refused
        for (uint256 i; i < 6; ++i) {
            handler.claim(1, i, address(this));
        }
        handler.passTime(3 days);
        handler.passTime(3 days);
        handler.passTime(3 days);
        handler.sweep(0);
        handler.sweep(1);
        assertGe(handler.claims(), 2);
        assertGe(handler.refusedOverTotal(), 1);
        assertEq(handler.sweeps(), 2);
        invariant_epochsNeverPayMoreThanFunded();
        invariant_balanceCoversOutstanding();
    }

    function afterInvariant() public {
        emit log_named_uint("epochs", handler.epochCount());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("claims refused over an epoch total", handler.refusedOverTotal());
        emit log_named_uint("sweeps", handler.sweeps());
    }
}
