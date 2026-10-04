// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PerplFundingSpikeParams} from "../../src/interfaces/ITemplatesV2.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {PerplFundingSpikeResolver} from "../../src/resolvers/PerplFundingSpikeResolver.sol";

/// Template 4 against Perpl's live Exchange. Every block is picked relative to the fork head; Perpl
/// keeps its funding history in storage, so reading it at the head is enough.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/PerplFundingSpikeResolver.fork.t.sol
contract PerplFundingSpikeResolverForkTest is Test {
    uint256 internal constant INTERVAL = 8571;
    /// Blocks in 24 hours at 300 ms, the value the deploy script uses (Monad measured about 302 ms).
    uint256 internal constant DAY_BLOCKS = 288_000;

    IPerplExchange internal exchange;
    PerplFundingSpikeResolver internal spike;

    /// The largest single-interval increment among the grid events in (start, end].
    struct Scan {
        uint256 events;
        uint256 offGrid;
        uint64 maxEvent;
        int256 maxIncrement;
        uint64 otherEvent; // an event with a smaller increment, if any
        int256 otherIncrement;
    }

    function _fork(string memory network, string memory rpcVar, string memory fallbackRpc) internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", network, ".json"));
        vm.createSelectFork(vm.envOr(rpcVar, fallbackRpc));
        exchange = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));
        spike = new PerplFundingSpikeResolver(exchange, 1000, DAY_BLOCKS);
    }

    function _forkMainnet() internal {
        _fork("monad-mainnet", "MONAD_MAINNET_RPC", "https://rpc.monad.xyz");
    }

    function _p(uint256 perpId, uint256 start, uint256 end, int256 threshold, uint256 exp)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PerplFundingSpikeParams({
                perpId: perpId,
                startBlock: uint64(start),
                endBlock: uint64(end),
                threshold: threshold,
                expectedScalingExp: uint8(exp)
            })
        );
    }

    /// A second, hand-decoded read path that shares no code with the resolver.
    function _rawSum(uint256 perpId, uint256 blockNumber) internal view returns (int256 sum, uint256 eventBlock) {
        (bool ok, bytes memory ret) = address(exchange)
            .staticcall(abi.encodeWithSignature("getFundingSumAtBlock(uint256,uint256)", perpId, blockNumber));
        require(ok, "raw read failed");
        (sum, eventBlock) = abi.decode(ret, (int256, uint256));
    }

    /// Walks back from the last event at or before `end` to `start`, event by event.
    function _scan(uint256 perpId, uint256 start, uint256 end) internal view returns (Scan memory s) {
        s.maxIncrement = type(int256).min;
        (int256 sum, uint256 e) = _rawSum(perpId, end);
        while (e > start) {
            (int256 prevSum, uint256 prev) = _rawSum(perpId, e - 1);
            ++s.events;
            if (prev != e - INTERVAL) {
                ++s.offGrid;
            } else {
                int256 inc = sum - prevSum;
                if (inc > s.maxIncrement) {
                    (s.otherEvent, s.otherIncrement) = (s.maxEvent, s.maxIncrement);
                    (s.maxEvent, s.maxIncrement) = (uint64(e), inc);
                } else if (inc < s.maxIncrement && s.otherEvent == 0) {
                    (s.otherEvent, s.otherIncrement) = (uint64(e), inc);
                }
            }
            (sum, e) = (prevSum, prev);
        }
    }

    function _log(Scan memory s) internal pure {
        console2.log("  events in window", s.events, "off-grid", s.offGrid);
        console2.log("  largest single-interval increment", s.maxIncrement);
        console2.log("  at event block", s.maxEvent);
        console2.log("  a smaller one", s.otherIncrement);
        console2.log("  at event block", s.otherEvent);
    }

    // ------------------------------------------------------------ mainnet

    /// Real BTC (perp 1) funding over the last 40 intervals: the largest single event proves a spike
    /// above one unit less, but not above itself (equal is not a spike); a smaller event does not
    /// prove the larger threshold; a block that is not an event proves nothing; and inside the
    /// challenge period empty evidence waits.
    function test_mainnet_realSpikeEdges() public {
        _forkMainnet();
        uint256 end = block.number - 1000;
        uint256 start = end - 40 * INTERVAL;
        Scan memory s = _scan(1, start, end);
        console2.log("fork head", block.number);
        console2.log("window", start, end);
        _log(s);
        assertEq(s.offGrid, 0, "BTC funding left its grid");

        bytes memory below = _p(1, start, end, s.maxIncrement - 1, 0);
        (Outcome o, bytes32 h) = spike.resolve(below, abi.encode(s.maxEvent));
        assertEq(uint8(o), uint8(Outcome.Yes));
        (int256 sumE,) = _rawSum(1, s.maxEvent);
        (int256 sumPrev,) = _rawSum(1, s.maxEvent - INTERVAL);
        assertEq(sumE - sumPrev, s.maxIncrement);
        assertEq(
            h,
            keccak256(
                abi.encode(
                    address(exchange),
                    uint256(1),
                    s.maxEvent,
                    int48(sumE),
                    uint256(s.maxEvent - INTERVAL),
                    int48(sumPrev)
                )
            )
        );
        console2.logBytes32(h);

        vm.expectRevert(
            abi.encodeWithSelector(
                PerplFundingSpikeResolver.NotASpike.selector, s.maxEvent, s.maxIncrement, s.maxIncrement
            )
        );
        spike.resolve(_p(1, start, end, s.maxIncrement, 0), abi.encode(s.maxEvent));

        if (s.otherEvent != 0) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    PerplFundingSpikeResolver.NotASpike.selector, s.otherEvent, s.otherIncrement, s.maxIncrement - 1
                )
            );
            spike.resolve(below, abi.encode(s.otherEvent));
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                PerplFundingSpikeResolver.NotAFundingEvent.selector, s.maxEvent + 1, uint256(s.maxEvent)
            )
        );
        spike.resolve(below, abi.encode(s.maxEvent + 1));

        // The window ended 1,000 blocks ago: the challenge period is still running.
        (o, h) = spike.resolve(_p(1, start, end, s.maxIncrement, 0), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
    }

    /// A window that ended more than a day of blocks ago: with nothing above the threshold, empty
    /// evidence settles NO; the threshold just below the largest event can still be proved.
    function test_mainnet_noAfterTheChallenge() public {
        _forkMainnet();
        uint256 end = block.number - DAY_BLOCKS - 5000;
        uint256 start = end - 20 * INTERVAL;
        Scan memory s = _scan(1, start, end);
        console2.log("window", start, end);
        _log(s);

        (Outcome o, bytes32 h) = spike.resolve(_p(1, start, end, s.maxIncrement, 0), "");
        assertEq(uint8(o), uint8(Outcome.No));
        (int256 sumEnd, uint256 lastEvent) = _rawSum(1, end);
        assertEq(
            h,
            keccak256(
                abi.encode(address(exchange), uint256(1), uint64(end), end + DAY_BLOCKS, lastEvent, int48(sumEnd))
            )
        );
        (o,) = spike.resolve(_p(1, start, end, s.maxIncrement - 1, 0), abi.encode(s.maxEvent));
        assertEq(uint8(o), uint8(Outcome.Yes));
    }

    function test_mainnet_validateAndDescribe() public {
        _forkMainnet();
        uint256 start = block.number + 1000;
        uint256 end = start + 2_016_000; // about a week at 0.3 s
        bytes memory params = _p(1, start, end, 30, 0);
        Window memory w = spike.validate(params);
        assertTrue(w.blockClock);
        assertEq(w.lock, start);
        assertEq(w.close, end);
        assertEq(w.settleDeadline, block.timestamp + (end + DAY_BLOCKS - block.number) + 7 days);
        string memory d = spike.describe(params);
        console2.log(d);
        assertEq(
            keccak256(bytes(d)),
            keccak256(
                bytes(
                    string.concat(
                        "YES if any single funding event on Perpl (BTC Perp, perp 1) after block ",
                        vm.toString(start),
                        " and at or before block ",
                        vm.toString(end),
                        " charges BTC longs more than $3 per BTC; NO if nobody proves one by block ",
                        vm.toString(end + DAY_BLOCKS),
                        ", about 24 hours after the window."
                    )
                )
            )
        );
        // The window may be at most 31 days of blocks.
        vm.expectRevert(
            abi.encodeWithSelector(
                PerplFundingSpikeResolver.WindowTooLong.selector,
                uint64(start),
                uint64(start + 31 * DAY_BLOCKS + 1),
                31 * DAY_BLOCKS
            )
        );
        spike.validate(_p(1, start, start + 31 * DAY_BLOCKS + 1, 30, 0));
    }

    // ------------------------------------------------------------ testnet

    /// The same edges on Perpl's testnet BTC perp (16).
    function test_testnet_realSpikeEdges() public {
        _fork("monad-testnet", "MONAD_TESTNET_RPC", "https://testnet-rpc.monad.xyz");
        uint256 end = block.number - 1000;
        uint256 start = end - 20 * INTERVAL;
        uint256 exp = exchange.getPerpetualInfoV2(16).fundingSumScalingExp;
        Scan memory s = _scan(16, start, end);
        console2.log("testnet window", start, end);
        _log(s);
        (Outcome o,) = spike.resolve(_p(16, start, end, s.maxIncrement - 1, exp), abi.encode(s.maxEvent));
        assertEq(uint8(o), uint8(Outcome.Yes));
        vm.expectRevert(
            abi.encodeWithSelector(
                PerplFundingSpikeResolver.NotASpike.selector, s.maxEvent, s.maxIncrement, s.maxIncrement
            )
        );
        spike.resolve(_p(16, start, end, s.maxIncrement, exp), abi.encode(s.maxEvent));
    }
}
