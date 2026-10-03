// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PerplFundingParams} from "../../src/interfaces/ITemplates.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {PerplFundingResolver} from "../../src/resolvers/PerplFundingResolver.sol";

/// Template S-1 against Perpl's live Exchange. Every block is picked relative to the fork head:
/// public RPCs serve historical state only about a million blocks back, and Perpl keeps its funding
/// history in storage, so reading it at the head is enough.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path test/fork/PerplFundingResolver.fork.t.sol
contract PerplFundingResolverForkTest is Test {
    uint256 internal constant INTERVAL = 8571;

    IPerplExchange internal exchange;
    PerplFundingResolver internal resolver;

    function _forkMainnet() internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        exchange = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));
        resolver = new PerplFundingResolver(exchange, 1000);
    }

    function _forkTestnet() internal returns (string memory json) {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        exchange = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));
        resolver = new PerplFundingResolver(exchange, 1000);
    }

    function _p(uint256 perpId, uint256 start, uint256 end, int256 threshold, uint256 exp)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PerplFundingParams({
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

    // ------------------------------------------------------------ mainnet

    /// Real BTC (perp 1) funding over the last ~20 intervals settles, and the answer equals an
    /// independent computation: hand-decoded reads, plus a walk over every funding event in between
    /// whose increments must add up to the same ΔF.
    struct Read {
        uint256 start;
        uint256 end;
        int256 sStart;
        uint256 eStart;
        int256 sEnd;
        uint256 eEnd;
        int256 delta;
    }

    function test_mainnet_btcWindowSettlesAndMatchesIndependentComputation() public {
        _forkMainnet();
        Read memory r;
        r.end = block.number - 1000;
        r.start = r.end - 20 * INTERVAL;
        (r.sStart, r.eStart) = _rawSum(1, r.start);
        (r.sEnd, r.eEnd) = _rawSum(1, r.end);
        r.delta = r.sEnd - r.sStart;

        (int256 walked, uint256 events, uint256 offGrid) = _walk(1, r.eStart, r.sStart, r.eEnd);
        assertEq(walked, r.delta, "event walk disagrees with the two-point difference");

        console2.log("fork head", block.number);
        console2.log("startBlock", r.start, "event", r.eStart);
        console2.log("endBlock", r.end, "event", r.eEnd);
        console2.log("F(start)", r.sStart);
        console2.log("F(end)", r.sEnd);
        console2.log("deltaF raw (USD per BTC x10)", r.delta);
        console2.log("funding events in window", events, "off-grid", offGrid);

        (Outcome o, bytes32 h) = resolver.resolve(_p(1, r.start, r.end, r.delta, 0), "");
        assertEq(uint8(o), uint8(Outcome.No), "equal must be NO");
        (o,) = resolver.resolve(_p(1, r.start, r.end, r.delta - 1, 0), "");
        assertEq(uint8(o), uint8(Outcome.Yes));
        (o,) = resolver.resolve(_p(1, r.start, r.end, 0, 0), "");
        assertEq(uint8(o), uint8(r.delta > 0 ? Outcome.Yes : Outcome.No));
        assertEq(h, _expectedHash(r));
        console2.logBytes32(h);
    }

    /// Walks every grid event after `eStart` up to `eEnd`, summing the increments.
    function _walk(uint256 perpId, uint256 eStart, int256 sStart, uint256 eEnd)
        internal
        view
        returns (int256 walked, uint256 events, uint256 offGrid)
    {
        int256 prev = sStart;
        for (uint256 b = eStart + INTERVAL; b <= eEnd; b += INTERVAL) {
            (int256 s, uint256 e) = _rawSum(perpId, b);
            if (e != b) ++offGrid;
            walked += s - prev;
            prev = s;
            ++events;
        }
    }

    function _expectedHash(Read memory r) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(exchange),
                uint256(1),
                uint64(r.start),
                uint64(r.end),
                int48(r.sStart),
                int48(r.sEnd),
                r.eStart,
                r.eEnd
            )
        );
    }

    function test_mainnet_unresolvedUntilAfterEndBlock() public {
        _forkMainnet();
        uint256 end = block.number;
        (Outcome o,) = resolver.resolve(_p(1, end - 5 * INTERVAL, end, 0, 0), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        vm.roll(end + 1);
        (o,) = resolver.resolve(_p(1, end - 5 * INTERVAL, end, 0, 0), "");
        assertTrue(o != Outcome.Unresolved);
    }

    function test_mainnet_validateAndDescribeFutureWindow() public {
        _forkMainnet();
        uint256 start = block.number + 1000;
        uint256 end = start + 2_016_000; // about a week at 0.3 s
        Window memory w = resolver.validate(_p(1, start, end, 5, 0));
        assertTrue(w.blockClock);
        assertEq(w.lock, start);
        assertEq(w.close, end);
        assertEq(w.settleDeadline, block.timestamp + (end - block.number) + 7 days);
        string memory d = resolver.describe(_p(1, start, end, 5, 0));
        console2.log(d);
        assertEq(
            keccak256(bytes(d)),
            keccak256(
                bytes(
                    string.concat(
                        "Will BTC longs pay more than $0.5 per BTC in funding on Perpl (BTC Perp, perp 1) between block ",
                        vm.toString(start),
                        " and block ",
                        vm.toString(end),
                        "?"
                    )
                )
            )
        );
        // MON (perp 10) uses scaling exponent 2: 0 is rejected, 2 is accepted.
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.ScalingExpMismatch.selector, 0, 2));
        resolver.validate(_p(10, start, end, 0, 0));
        resolver.validate(_p(10, start, end, 0, 2));
    }

    function test_mainnet_refusals() public {
        _forkMainnet();
        uint256 end = block.number - 1000;
        uint256 start = end - 5 * INTERVAL;

        // Unknown perp: validate reverts, resolve refuses.
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.PerpNotListed.selector, 2));
        resolver.validate(_p(2, block.number + 10, block.number + 10 + INTERVAL, 0, 0));
        (Outcome o,) = resolver.resolve(_p(2, start, end, 0, 0), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));

        // Legacy SOL perp 30 is paused: validate reverts; its sum stopped moving, so resolve refuses.
        vm.expectRevert(abi.encodeWithSelector(PerplFundingResolver.PerpPaused.selector, 30));
        resolver.validate(_p(30, block.number + 10, block.number + 10 + INTERVAL, 0, 3));
        (o,) = resolver.resolve(_p(30, start, end, 0, 3), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));

        // Wrong units recorded at creation: refuses.
        (o,) = resolver.resolve(_p(1, start, end, 0, 1), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));

        // Perpl reports a new version: refuses.
        assertTrue(resolver.versionUnchanged());
        vm.mockCall(
            address(exchange),
            abi.encodeWithSelector(IPerplExchange.getContractVersion.selector),
            abi.encode(resolver.versionMajor(), resolver.versionMinor(), resolver.versionPatch() + 1)
        );
        assertFalse(resolver.versionUnchanged());
        (o,) = resolver.resolve(_p(1, start, end, 0, 0), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        vm.clearMockedCalls();
        (o,) = resolver.resolve(_p(1, start, end, 0, 0), "");
        assertTrue(o != Outcome.Unresolved);
    }

    function test_mainnet_pinnedVersion() public {
        _forkMainnet();
        console2.log("Perpl version v1", resolver.versionMajor(), resolver.versionMinor(), resolver.versionPatch());
        // Perpl renders (1, 7, 5) as "v1.1.7.5".
        assertEq(resolver.versionMajor(), 1);
        assertEq(resolver.versionMinor(), 7);
        assertEq(exchange.getFundingInterval(), INTERVAL);
    }

    // ------------------------------------------------------------ testnet

    /// Are Perpl's testnet perps (BTC 16, ETH 32, SOL 48, MON 64) paying funding right now?
    function test_testnet_perpsHaveLiveFunding() public {
        _forkTestnet();
        uint256[4] memory ids = [uint256(16), 32, 48, 64];
        uint256 head = block.number;
        console2.log("testnet fork head", head);
        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids[i];
            assertTrue(resolver.isListed(id), "testnet perp not listed");
            (int256 sNow, uint256 eNow) = _rawSum(id, head - 1);
            (int256 sOld, uint256 eOld) = _rawSum(id, head - 1 - 10 * INTERVAL);
            console2.log("perp", id);
            console2.log("  last event block", eNow, "blocks ago", head - 1 - eNow);
            console2.log("  F now", sNow);
            console2.log("  F 10 intervals ago", sOld);
            console2.log("  at event", eOld);
            assertLe(head - 1 - eNow, INTERVAL, "no funding event in the last interval");

            uint256 end = head - 100;
            (Outcome o,) = resolver.resolve(_p(id, end - 10 * INTERVAL, end, 0, _exp(id)), "");
            assertTrue(o != Outcome.Unresolved, "a recent testnet window should settle");
        }
    }

    function _exp(uint256 id) internal view returns (uint256) {
        return exchange.getPerpetualInfoV2(id).fundingSumScalingExp;
    }
}
