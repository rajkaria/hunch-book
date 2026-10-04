// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Outcome, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {Snapshot, SnapshotParams, SnapshotSource} from "../../src/interfaces/ITemplatesV3.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {SnapshotResolver} from "../../src/resolvers/SnapshotResolver.sol";
import {SnapshotStore} from "../../src/resolvers/SnapshotStore.sol";
import {PerplSnapshotSources} from "../../script/DeploySnapshotTemplate.s.sol";
import {MockSnapshotSource} from "./SnapshotMocks.sol";

contract SnapshotResolverTest is Test {
    uint256 internal constant NOW_TS = 1_800_000_000; // 2027-01-15 08:00:00 UTC
    uint256 internal constant NOW_BLOCK = 1_000_000;
    uint256 internal constant BTC = 1;

    uint16 internal constant OI = 0; // Perpl-shaped: open interest, 5 lot decimals
    uint16 internal constant MARK = 1; // Perpl-shaped: mark price, 1 price decimal, max age 120 s
    uint16 internal constant PLAIN = 2; // one unsigned word, no checks
    uint16 internal constant STAMPED = 3; // a signed value with its own timestamp, max age 60 s

    uint64 internal constant LOCK = uint64(NOW_TS + 1 days);
    uint64 internal constant CLOSE = uint64(NOW_TS + 2 days); // 2027-01-17 08:00:00 UTC
    uint32 internal constant WINDOW = 10 minutes;

    uint256 internal constant OPEN_INTEREST = 954_501; // 9.54501 BTC
    uint256 internal constant MARK_PRICE = 849_859; // $84,985.9

    MockSnapshotSource internal src;
    SnapshotResolver internal resolver;

    receive() external payable {}

    function setUp() public {
        vm.warp(NOW_TS);
        vm.roll(NOW_BLOCK);
        src = new MockSnapshotSource();
        src.listPerp(BTC, "BTC", 1, 5);
        src.setMark(BTC, MARK_PRICE, NOW_TS);
        src.setOpenInterest(BTC, OPEN_INTEREST);
        src.setPlain(42);
        src.setSigned(-5, NOW_TS);
        resolver = new SnapshotResolver(_sources(src));
    }

    // ------------------------------------------------------------ helpers

    function _sources(MockSnapshotSource s) internal view returns (SnapshotSource[] memory list) {
        list = new SnapshotSource[](4);
        list[OI] = PerplSnapshotSources.openInterest(IPerplExchange(address(s)), BTC, "BTC");
        list[MARK] = PerplSnapshotSources.markPrice(IPerplExchange(address(s)), BTC, "BTC");
        list[PLAIN] = _plainSource(s);
        list[STAMPED] = _stampedSource(s);
    }

    function _plainSource(MockSnapshotSource s) internal pure returns (SnapshotSource memory x) {
        x.label = "the plain word";
        x.unit = "units";
        x.target = address(s);
        x.callData = abi.encodeCall(MockSnapshotSource.plain, ());
    }

    function _stampedSource(MockSnapshotSource s) internal pure returns (SnapshotSource memory x) {
        x.label = "the stamped value";
        x.unit = "points";
        x.decimals = 2;
        x.target = address(s);
        x.callData = abi.encodeCall(MockSnapshotSource.stamped, ());
        x.signed = true;
        x.timestampWord = 1;
        x.maxAge = 60;
    }

    function _one(SnapshotSource memory s) internal pure returns (SnapshotSource[] memory list) {
        list = new SnapshotSource[](1);
        list[0] = s;
    }

    function _p(uint16 sourceId, int256 threshold, uint8 comparator, uint64 lock, uint64 close, uint32 window)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            SnapshotParams({
                sourceId: sourceId,
                threshold: threshold,
                comparator: comparator,
                lockTime: lock,
                closeTime: close,
                snapshotWindow: window
            })
        );
    }

    function _q(uint16 sourceId, int256 threshold, uint8 comparator) internal pure returns (bytes memory) {
        return _p(sourceId, threshold, comparator, LOCK, CLOSE, WINDOW);
    }

    function _resolve(bytes memory params) internal returns (Outcome o) {
        (o,) = resolver.resolve(params, "");
    }

    function _stored(uint16 sourceId) internal view returns (Snapshot memory) {
        return resolver.snapshotOf(resolver.snapshotKey(sourceId, CLOSE, WINDOW));
    }

    function _hash(uint16 sourceId, int256 value, uint256 blockNumber, uint256 timestamp)
        internal
        view
        returns (bytes32)
    {
        SnapshotSource memory s = resolver.source(sourceId);
        return keccak256(abi.encode(s.target, s.callData, s.valueWord, value, uint64(blockNumber), uint64(timestamp)));
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_storesTheSources() public view {
        assertEq(resolver.sourceCount(), 4);
        assertFalse(resolver.earlyYes());

        SnapshotSource memory oi = resolver.source(OI);
        assertEq(oi.label, "Perpl's BTC open interest (perp 1)");
        assertEq(oi.unit, "BTC");
        assertEq(oi.decimals, 5);
        assertEq(oi.target, address(src));
        assertEq(oi.callData, abi.encodeCall(IPerplExchange.getPerpetualInfoV2, (BTC)));
        assertTrue(oi.tuple);
        assertEq(oi.valueWord, 17);
        assertFalse(oi.signed);
        assertEq(oi.maxAge, 0);
        assertEq(oi.pinnedWords.length, 4);
        assertEq(oi.guardTarget, address(src));
        assertEq(oi.guardCallData, abi.encodeCall(IPerplExchange.getContractVersion, ()));

        SnapshotSource memory mark = resolver.source(MARK);
        assertEq(mark.label, "Perpl's BTC mark price (perp 1)");
        assertEq(mark.unit, "USD");
        assertEq(mark.decimals, 1);
        assertEq(mark.valueWord, 11);
        assertEq(mark.timestampWord, 12);
        assertEq(mark.maxAge, 120);

        // The pin commits to the pinned words and the guard's answer as read at deployment.
        uint256[] memory pinned = new uint256[](4);
        (pinned[0], pinned[1], pinned[2], pinned[3]) = (1, 5, 1000, 4);
        bytes32 version = keccak256(abi.encode(uint256(7), uint256(5), uint256(0)));
        assertEq(resolver.sourcePin(OI), keccak256(abi.encode(pinned, version)));
        assertEq(resolver.sourcePin(PLAIN), keccak256(abi.encode(new uint256[](0), bytes32(0))));

        assertEq(resolver.currentValue(OI), int256(OPEN_INTEREST));
        assertEq(resolver.currentValue(MARK), int256(MARK_PRICE));
        assertEq(resolver.currentValue(PLAIN), 42);
        assertEq(resolver.currentValue(STAMPED), -5);
    }

    /// The same vector packages/shared/test/snapshot.test.ts checks, computed there with viem and cast.
    function test_snapshotKeyVector() public view {
        assertEq(
            resolver.snapshotKey(0, 1_800_172_800, 600),
            0x9ad96da60029167139ccaf508f69e2a060723ff418c0301406683d338559d02b
        );
    }

    function test_views_rejectUnknownSources() public {
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.UnknownSource.selector, uint16(4)));
        resolver.source(4);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.UnknownSource.selector, uint16(4)));
        resolver.sourcePin(4);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.UnknownSource.selector, uint16(4)));
        resolver.currentValue(4);
    }

    /// The library's word indexes against Perpl's struct: field i of a struct whose fields all differ
    /// sits at word i of the returned tuple.
    function test_perplWordIndexesMatchTheStruct() public {
        src.listPerp(7, "X", 0, 0);
        src.setDistinctFields(7);
        (bool ok, bytes memory ret) = address(src).staticcall(abi.encodeCall(IPerplExchange.getPerpetualInfoV2, (7)));
        assertTrue(ok);
        uint256 head = uint256(bytes32(ret));
        assertEq(head, 32);
        uint16[8] memory words = [
            PerplSnapshotSources.PRICE_DECIMALS,
            PerplSnapshotSources.LOT_DECIMALS,
            PerplSnapshotSources.MARK,
            PerplSnapshotSources.MARK_TIMESTAMP,
            PerplSnapshotSources.LONG_OPEN_INTEREST,
            PerplSnapshotSources.SHORT_OPEN_INTEREST,
            PerplSnapshotSources.FUNDING_START_BLOCK,
            PerplSnapshotSources.STATUS
        ];
        uint256[8] memory expected = [uint256(1002), 1003, 1011, 1012, 1017, 1018, 1019, 22];
        for (uint256 i = 0; i < words.length; ++i) {
            uint256 offset = head + 32 * uint256(words[i]);
            uint256 word;
            assembly {
                word := mload(add(add(ret, 0x20), offset))
            }
            assertEq(word, expected[i]);
        }
        // And the resolver reads the same word. (The library reads decimals from the perp, and 1003
        // does not fit in uint8, so the source is built on perp 1 and pointed at perp 7.)
        SnapshotSource memory s = PerplSnapshotSources.openInterest(IPerplExchange(address(src)), BTC, "X");
        s.callData = abi.encodeCall(IPerplExchange.getPerpetualInfoV2, (7));
        assertEq(new SnapshotResolver(_one(s)).currentValue(0), 1017);
    }

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(SnapshotResolver.NoSources.selector);
        new SnapshotResolver(new SnapshotSource[](0));

        SnapshotSource memory s = _plainSource(src);
        s.label = "";
        vm.expectRevert(SnapshotResolver.EmptyLabel.selector);
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.unit = "";
        vm.expectRevert(SnapshotResolver.EmptyLabel.selector);
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.target = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.NotAContract.selector, address(0xBEEF)));
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.callData = hex"aabbcc";
        vm.expectRevert(SnapshotResolver.MissingSelector.selector);
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.valueWord = 64;
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.WordOutOfRange.selector, uint256(64)));
        new SnapshotResolver(_one(s));

        s = _stampedSource(src);
        s.timestampWord = 64;
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.WordOutOfRange.selector, uint256(64)));
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.timestampWord = 1; // a timestamp word without a max age means nothing
        vm.expectRevert(SnapshotResolver.UnusedFieldSet.selector);
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.pinnedWords = new uint16[](9);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.TooManyPinnedWords.selector, uint256(9)));
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.pinnedWords = new uint16[](1);
        s.pinnedWords[0] = 64;
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.WordOutOfRange.selector, uint256(64)));
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.guardCallData = abi.encodeCall(IPerplExchange.getContractVersion, ());
        vm.expectRevert(SnapshotResolver.UnusedFieldSet.selector);
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.guardTarget = address(0xBEEF);
        s.guardCallData = abi.encodeCall(IPerplExchange.getContractVersion, ());
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.NotAContract.selector, address(0xBEEF)));
        new SnapshotResolver(_one(s));

        s = _plainSource(src);
        s.guardTarget = address(src);
        vm.expectRevert(SnapshotResolver.MissingSelector.selector);
        new SnapshotResolver(_one(s));

        SnapshotSource[] memory twice = new SnapshotSource[](2);
        twice[0] = _plainSource(src);
        twice[1] = _plainSource(src);
        twice[1].label = "the same read under another name";
        vm.expectRevert(SnapshotResolver.DuplicateEntry.selector);
        new SnapshotResolver(twice);
    }

    /// Every source is read once at deployment; one that cannot be read now rejects the deployment.
    function test_constructor_rejectsUnreadableSources() public {
        src.setReverts(true);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceCallFailed.selector, uint16(0)));
        new SnapshotResolver(_one(_plainSource(src)));
        src.setReverts(false);

        src.setPlain(uint256(type(int256).max) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SnapshotResolver.ValueOutOfRange.selector, uint16(0), uint256(type(int256).max) + 1)
        );
        new SnapshotResolver(_one(_plainSource(src)));
        src.setPlain(42);

        src.setSigned(1, NOW_TS - 61);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.ValueStale.selector, uint16(0), NOW_TS - 61, 60));
        new SnapshotResolver(_one(_stampedSource(src)));

        src.setVersionReverts(true);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.GuardCallFailed.selector, uint16(0)));
        new SnapshotResolver(_one(PerplSnapshotSources.openInterest(IPerplExchange(address(src)), BTC, "BTC")));
    }

    // ------------------------------------------------------------ validate

    function test_validate_window() public view {
        Window memory w = resolver.validate(_q(OI, 10e5, resolver.ABOVE()));
        assertFalse(w.blockClock);
        assertEq(w.lock, LOCK);
        assertEq(w.close, CLOSE);
        assertEq(w.settleDeadline, CLOSE + WINDOW + 7 days);
        // Lock and close may coincide.
        w = resolver.validate(_p(PLAIN, 0, 0, LOCK, LOCK, 1 minutes));
        assertEq(w.settleDeadline, LOCK + 1 minutes + 7 days);
    }

    function test_validate_rejectsBadParams() public {
        vm.expectRevert(SnapshotResolver.NonCanonicalParams.selector);
        resolver.validate(bytes.concat(_q(OI, 0, 0), bytes1(0)));

        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.UnknownSource.selector, uint16(4)));
        resolver.validate(_q(4, 0, 0));

        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.UnknownComparator.selector, uint8(4)));
        resolver.validate(_q(OI, 0, 4));

        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SnapshotWindowOutOfRange.selector, uint32(59)));
        resolver.validate(_p(OI, 0, 0, LOCK, CLOSE, 59));
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SnapshotWindowOutOfRange.selector, uint32(1801)));
        resolver.validate(_p(OI, 0, 0, LOCK, CLOSE, 1801));
        resolver.validate(_p(OI, 0, 0, LOCK, CLOSE, 60));
        resolver.validate(_p(OI, 0, 0, LOCK, CLOSE, 1800));

        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.LockNotInFuture.selector, uint64(NOW_TS), NOW_TS));
        resolver.validate(_p(OI, 0, 0, uint64(NOW_TS), CLOSE, WINDOW));

        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.CloseBeforeLock.selector, LOCK, LOCK - 1));
        resolver.validate(_p(OI, 0, 0, LOCK, LOCK - 1, WINDOW));

        uint64 far = type(uint64).max - 7 days - WINDOW + 1;
        vm.expectRevert(SnapshotResolver.DeadlineOverflow.selector);
        resolver.validate(_p(OI, 0, 0, LOCK, far, WINDOW));
        resolver.validate(_p(OI, 0, 0, LOCK, far - 1, WINDOW));
    }

    /// A new market needs a source that answers now, with the identity, units, status and version it
    /// had at deployment.
    function test_validate_rejectsASourceThatChangedOrFails() public {
        bytes memory oi = _q(OI, 0, 0);
        src.setStatus(BTC, 0); // paused
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        resolver.validate(oi);
        src.setStatus(BTC, 4);

        src.setDecimals(BTC, 1, 6);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        resolver.validate(oi);
        src.setDecimals(BTC, 1, 5);

        src.setFundingStartBlock(BTC, 2000); // the id was listed again
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        resolver.validate(oi);
        src.setFundingStartBlock(BTC, 1000);

        src.setVersion(7, 6, 0);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        resolver.validate(oi);
        src.setVersion(7, 5, 0);

        src.delistPerp(BTC);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceCallFailed.selector, OI));
        resolver.validate(oi);
        src.listPerp(BTC, "BTC", 1, 5);
        src.setMark(BTC, MARK_PRICE, NOW_TS);

        vm.warp(NOW_TS + 121);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.ValueStale.selector, MARK, NOW_TS, uint256(120)));
        resolver.validate(_p(MARK, 0, 0, LOCK, CLOSE, WINDOW));
        resolver.validate(oi); // open interest has no timestamp: never stale
    }

    // ------------------------------------------------------------ describe

    function test_describe() public view {
        assertEq(
            resolver.describe(_q(OI, 10e5, 0)),
            "YES if Perpl's BTC open interest (perp 1) is above 10 BTC in the first snapshot taken from 2027-01-17 08:00:00 UTC to 2027-01-17 08:10:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids."
        );
        assertEq(
            resolver.describe(_q(MARK, 850_000, 1)),
            "YES if Perpl's BTC mark price (perp 1) is at or above $85,000 in the first snapshot taken from 2027-01-17 08:00:00 UTC to 2027-01-17 08:10:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids."
        );
        assertEq(
            resolver.describe(_p(STAMPED, -125, 2, LOCK, CLOSE, 1 minutes)),
            "YES if the stamped value is below -1.25 points in the first snapshot taken from 2027-01-17 08:00:00 UTC to 2027-01-17 08:01:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids."
        );
        assertEq(
            resolver.describe(_q(PLAIN, 1_234_567, 3)),
            "YES if the plain word is at or below 1,234,567 units in the first snapshot taken from 2027-01-17 08:00:00 UTC to 2027-01-17 08:10:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids."
        );
    }

    function test_describe_unknownSourceAndComparator() public view {
        assertEq(resolver.describe(_q(9, 0, 0)), "Unknown snapshot source 9.");
        assertEq(
            resolver.describe(_q(PLAIN, 1, 7)),
            "YES if the plain word is (comparator 7) 1 units in the first snapshot taken from 2027-01-17 08:00:00 UTC to 2027-01-17 08:10:00 UTC; NO otherwise. If nobody takes a snapshot in that window, the market voids."
        );
    }

    // ------------------------------------------------------------ snapshot

    function test_snapshot_storesTheValueOnce() public {
        vm.warp(CLOSE);
        vm.roll(NOW_BLOCK + 500);
        bytes32 key = resolver.snapshotKey(OI, CLOSE, WINDOW);
        assertEq(key, keccak256(abi.encode(OI, CLOSE, WINDOW)));

        address taker = makeAddr("taker");
        vm.expectEmit(true, true, true, true, address(resolver));
        emit SnapshotStore.SnapshotTaken(
            key, OI, taker, CLOSE, WINDOW, int256(OPEN_INTEREST), uint64(NOW_BLOCK + 500), CLOSE
        );
        vm.prank(taker);
        assertEq(resolver.snapshot(OI, CLOSE, WINDOW), int256(OPEN_INTEREST));

        Snapshot memory s = resolver.snapshotOf(key);
        assertEq(s.value, int256(OPEN_INTEREST));
        assertEq(s.blockNumber, NOW_BLOCK + 500);
        assertEq(s.timestamp, CLOSE);
        (bytes32 k, Snapshot memory f) = resolver.snapshotFor(_q(OI, 0, 0));
        assertEq(k, key);
        assertEq(f.value, s.value);

        // Later in the window the source moves; the snapshot does not.
        vm.warp(CLOSE + 5);
        vm.roll(NOW_BLOCK + 510);
        src.setOpenInterest(BTC, 1);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SnapshotExists.selector, key));
        resolver.snapshot(OI, CLOSE, WINDOW);
        assertEq(resolver.snapshotOf(key).value, int256(OPEN_INTEREST));
        assertEq(uint8(_resolve(_q(OI, int256(OPEN_INTEREST) - 1, 0))), uint8(Outcome.Yes));
    }

    function test_snapshot_windowEdges() public {
        vm.warp(CLOSE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SnapshotResolver.OutsideSnapshotWindow.selector, CLOSE, uint256(CLOSE) + WINDOW, uint256(CLOSE) - 1
            )
        );
        resolver.snapshot(OI, CLOSE, WINDOW);

        vm.warp(uint256(CLOSE) + WINDOW + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SnapshotResolver.OutsideSnapshotWindow.selector,
                CLOSE,
                uint256(CLOSE) + WINDOW,
                uint256(CLOSE) + WINDOW + 1
            )
        );
        resolver.snapshot(OI, CLOSE, WINDOW);

        // Both ends count.
        vm.warp(uint256(CLOSE) + WINDOW);
        resolver.snapshot(OI, CLOSE, WINDOW);
        vm.warp(CLOSE);
        resolver.snapshot(PLAIN, CLOSE, WINDOW);
    }

    function test_snapshot_rejectsBadObservations() public {
        vm.warp(CLOSE);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.UnknownSource.selector, uint16(4)));
        resolver.snapshot(4, CLOSE, WINDOW);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SnapshotWindowOutOfRange.selector, uint32(0)));
        resolver.snapshot(OI, CLOSE, 0);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SnapshotWindowOutOfRange.selector, uint32(1801)));
        resolver.snapshot(OI, CLOSE, 1801);
    }

    /// Each observation (source, close, window) has its own snapshot; questions about the same one
    /// share it.
    function test_snapshot_oneSnapshotPerObservation() public {
        vm.warp(CLOSE);
        src.setMark(BTC, MARK_PRICE, CLOSE);
        resolver.snapshot(OI, CLOSE, WINDOW);
        // Another window length or another source is another observation.
        resolver.snapshot(OI, CLOSE, WINDOW + 1);
        resolver.snapshot(MARK, CLOSE, WINDOW);
        vm.warp(CLOSE + 1);
        resolver.snapshot(OI, CLOSE + 1, WINDOW);
        assertEq(_stored(OI).value, int256(OPEN_INTEREST));
        assertEq(resolver.snapshotOf(resolver.snapshotKey(OI, CLOSE + 1, WINDOW)).timestamp, CLOSE + 1);

        // Questions with other thresholds, comparators and lock times all read the one snapshot.
        src.setOpenInterest(BTC, 0);
        assertEq(uint8(_resolve(_q(OI, int256(OPEN_INTEREST), 0))), uint8(Outcome.No));
        assertEq(uint8(_resolve(_q(OI, int256(OPEN_INTEREST), 1))), uint8(Outcome.Yes));
        assertEq(uint8(_resolve(_p(OI, int256(OPEN_INTEREST), 1, LOCK - 1 hours, CLOSE, WINDOW))), uint8(Outcome.Yes));
    }

    /// A read that cannot be vouched for stores nothing, and the snapshot can still be taken once the
    /// source is back, inside the window.
    function test_snapshot_refusesAndStoresNothing() public {
        vm.warp(CLOSE);

        src.setReverts(true);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceCallFailed.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setReverts(false);

        src.setTruncateTo(32 * 18); // the head offset and 17 words: one short of word 17
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceReturnTooShort.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setTruncateTo(32 * 19);
        // The value is there now, but pinned word 19 (funding start block) is not.
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceReturnTooShort.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setTruncateTo(0);

        src.setStatus(BTC, 0);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setStatus(BTC, 4);

        src.setVersion(8, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setVersion(7, 5, 0);

        src.setVersionReverts(true);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.GuardCallFailed.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setVersionReverts(false);

        src.setVersionPadding(1024 - 96 + 1); // one byte over MAX_GUARD_RETURN
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.GuardCallFailed.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setVersionPadding(1024 - 96); // exactly MAX_GUARD_RETURN, but no longer the same answer
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, OI));
        resolver.snapshot(OI, CLOSE, WINDOW);
        src.setVersionPadding(0);

        // A stale mark: refused while stale, taken once Perpl updates it.
        src.setMark(BTC, MARK_PRICE, CLOSE - 121);
        vm.expectRevert(
            abi.encodeWithSelector(SnapshotResolver.ValueStale.selector, MARK, uint256(CLOSE) - 121, uint256(120))
        );
        resolver.snapshot(MARK, CLOSE, WINDOW);
        src.setMark(BTC, MARK_PRICE, CLOSE - 120); // exactly the max age is fine
        resolver.snapshot(MARK, CLOSE, WINDOW);

        assertEq(_stored(OI).blockNumber, 0, "a refused read stored something");
        vm.warp(CLOSE + 1 minutes);
        assertEq(resolver.snapshot(OI, CLOSE, WINDOW), int256(OPEN_INTEREST));
        assertEq(_stored(OI).timestamp, CLOSE + 1 minutes);
    }

    /// A changed source is reported as changed, even when its value is also stale.
    function test_snapshot_changedTakesPrecedence() public {
        vm.warp(CLOSE);
        src.setMark(BTC, MARK_PRICE, 1);
        src.setStatus(BTC, 0);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceChanged.selector, MARK));
        resolver.snapshot(MARK, CLOSE, WINDOW);
    }

    function test_snapshot_signedAndStampedValues() public {
        vm.warp(CLOSE);
        src.setSigned(-123_456, CLOSE - 60);
        assertEq(resolver.snapshot(STAMPED, CLOSE, WINDOW), -123_456);
        // A source timestamp ahead of the block counts as fresh.
        src.setSigned(7, CLOSE + 1 hours);
        assertEq(resolver.currentValue(STAMPED), 7);
        src.setSigned(7, CLOSE - 61);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.ValueStale.selector, STAMPED, uint256(CLOSE) - 61, 60));
        resolver.currentValue(STAMPED);
    }

    function test_snapshot_unsignedRange() public {
        src.setPlain(uint256(type(int256).max));
        assertEq(resolver.currentValue(PLAIN), type(int256).max);
        src.setPlain(uint256(type(int256).max) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SnapshotResolver.ValueOutOfRange.selector, PLAIN, uint256(type(int256).max) + 1)
        );
        resolver.currentValue(PLAIN);
    }

    /// Reads copy single words: a long answer is read correctly, and a tuple whose head points past
    /// the end of the data fails instead of decoding garbage.
    function test_snapshot_returnDataShapes() public {
        SnapshotSource memory big = _plainSource(src);
        big.callData = abi.encodeCall(MockSnapshotSource.padded, (100_000));
        SnapshotSource memory bad = _plainSource(src);
        bad.callData = abi.encodeCall(MockSnapshotSource.badOffset, ());
        bad.tuple = true;
        SnapshotResolver r = new SnapshotResolver(_one(big));
        assertEq(r.currentValue(0), 42);
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.SourceReturnTooShort.selector, uint16(0)));
        new SnapshotResolver(_one(bad));
        // The same call read as a flat return is fine: word 1 holds 7.
        bad.tuple = false;
        bad.valueWord = 1;
        assertEq(new SnapshotResolver(_one(bad)).currentValue(0), 7);
    }

    // ------------------------------------------------------------ resolve

    function test_resolve_unresolvedBeforeClose() public {
        vm.warp(CLOSE - 1);
        (Outcome o, bytes32 h) = resolver.resolve(_q(OI, 0, 0), "");
        assertEq(uint8(o), uint8(Outcome.Unresolved));
        assertEq(h, bytes32(0));
        assertEq(_stored(OI).blockNumber, 0);
    }

    /// Inside the window with no snapshot, resolve takes it: one transaction settles the market.
    function test_resolve_takesTheSnapshotInsideTheWindow() public {
        vm.warp(CLOSE + 3);
        vm.roll(NOW_BLOCK + 700);
        src.setMark(BTC, MARK_PRICE, CLOSE - 30); // Perpl updated the mark 33 seconds ago
        bytes32 key = resolver.snapshotKey(MARK, CLOSE, WINDOW);
        bytes memory params = _q(MARK, 850_000, 1); // at or above $85,000
        vm.expectEmit(true, true, true, true, address(resolver));
        emit SnapshotStore.SnapshotTaken(
            key, MARK, address(this), CLOSE, WINDOW, int256(MARK_PRICE), uint64(NOW_BLOCK + 700), CLOSE + 3
        );
        (Outcome o, bytes32 h) = resolver.resolve(params, "");
        assertEq(uint8(o), uint8(Outcome.No)); // $84,985.9 < $85,000
        assertEq(h, _hash(MARK, int256(MARK_PRICE), NOW_BLOCK + 700, CLOSE + 3));
        assertEq(
            h,
            keccak256(
                abi.encode(
                    address(src),
                    abi.encodeCall(IPerplExchange.getPerpetualInfoV2, (BTC)),
                    uint16(11),
                    int256(MARK_PRICE),
                    uint64(NOW_BLOCK + 700),
                    uint64(CLOSE + 3)
                )
            )
        );
        assertEq(_stored(MARK).blockNumber, NOW_BLOCK + 700);
    }

    function test_resolve_answersFromTheSnapshotForever() public {
        vm.warp(CLOSE);
        resolver.snapshot(OI, CLOSE, WINDOW);
        uint256 takenAt = vm.getBlockNumber();
        vm.warp(CLOSE + 6 days);
        vm.roll(NOW_BLOCK + 9_000_000);
        src.setOpenInterest(BTC, 0);
        src.setReverts(true); // the source has no say any more
        (Outcome o, bytes32 h) = resolver.resolve(_q(OI, 9e5, resolver.ABOVE()), "");
        assertEq(uint8(o), uint8(Outcome.Yes));
        assertEq(h, _hash(OI, int256(OPEN_INTEREST), takenAt, CLOSE));
    }

    /// No snapshot by the end of the window: no answer, for good. The market voids at its deadline.
    function test_resolve_unresolvedForGoodWithoutASnapshot() public {
        vm.warp(uint256(CLOSE) + WINDOW + 1);
        assertEq(uint8(_resolve(_q(OI, 0, 0))), uint8(Outcome.Unresolved));
        vm.warp(uint256(CLOSE) + WINDOW + 6 days);
        assertEq(uint8(_resolve(_q(OI, 0, 0))), uint8(Outcome.Unresolved));
        assertEq(_stored(OI).blockNumber, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                SnapshotResolver.OutsideSnapshotWindow.selector,
                CLOSE,
                uint256(CLOSE) + WINDOW,
                uint256(CLOSE) + WINDOW + 6 days
            )
        );
        resolver.snapshot(OI, CLOSE, WINDOW);
    }

    /// Inside the window, a source that cannot be read gives `Unresolved` and stores nothing; a later
    /// call in the window takes the snapshot.
    function test_resolve_inWindowRefusalIsUnresolvedThenRetries() public {
        vm.warp(CLOSE);
        src.setVersion(9, 9, 9);
        assertEq(uint8(_resolve(_q(OI, 0, 0))), uint8(Outcome.Unresolved));
        src.setVersion(7, 5, 0);
        src.setReverts(true);
        assertEq(uint8(_resolve(_q(OI, 0, 0))), uint8(Outcome.Unresolved));
        src.setReverts(false);
        src.setTruncateTo(64);
        assertEq(uint8(_resolve(_q(OI, 0, 0))), uint8(Outcome.Unresolved));
        src.setTruncateTo(0);
        assertEq(_stored(OI).blockNumber, 0);
        vm.warp(CLOSE + 2 minutes);
        assertEq(uint8(_resolve(_q(OI, 0, 0))), uint8(Outcome.Yes));
        assertEq(_stored(OI).timestamp, CLOSE + 2 minutes);
    }

    function test_resolve_rejectsEvidenceAndBadParams() public {
        vm.warp(CLOSE);
        vm.expectRevert(SnapshotResolver.EvidenceNotEmpty.selector);
        resolver.resolve(_q(OI, 0, 0), hex"00");
        vm.expectRevert(SnapshotResolver.NonCanonicalParams.selector);
        resolver.resolve(bytes.concat(_q(OI, 0, 0), bytes1(0)), "");
        vm.expectRevert(abi.encodeWithSelector(SnapshotResolver.UnknownComparator.selector, uint8(4)));
        resolver.resolve(_q(OI, 0, 4), "");
    }

    function test_resolve_refundsValue() public {
        vm.deal(address(this), 3 ether);
        resolver.resolve{value: 1 ether}(_q(OI, 0, 0), ""); // before close
        vm.warp(CLOSE);
        resolver.resolve{value: 1 ether}(_q(OI, 0, 0), ""); // takes the snapshot
        resolver.resolve{value: 1 ether}(_q(OI, 0, 0), ""); // reads it
        assertEq(address(this).balance, 3 ether);
        assertEq(address(resolver).balance, 0);
    }

    // ------------------------------------------------------------ fuzz

    /// The rule for every comparator at every distance from the threshold, the equal case included.
    function testFuzz_comparatorEdges(int256 value, int256 threshold, uint8 comparator) public {
        comparator = uint8(bound(comparator, 0, 3));
        vm.warp(CLOSE);
        src.setSigned(value, CLOSE);
        (Outcome o,) = resolver.resolve(_q(STAMPED, threshold, comparator), "");
        bool yes;
        if (comparator == 0) yes = value > threshold;
        else if (comparator == 1) yes = value >= threshold;
        else if (comparator == 2) yes = value < threshold;
        else yes = value <= threshold;
        assertEq(uint8(o), uint8(yes ? Outcome.Yes : Outcome.No));
    }

    /// The equal case and one unit either side, for each comparator: above and below never include
    /// the threshold, the "at or" forms always do.
    function testFuzz_equalAndAdjacent(int128 t) public {
        int256 threshold = int256(t);
        int256[3] memory values = [threshold - 1, threshold, threshold + 1];
        bool[3][4] memory expected = [
            [false, false, true], // above
            [false, true, true], // at or above
            [true, false, false], // below
            [true, true, false] // at or below
        ];
        for (uint256 i = 0; i < 3; ++i) {
            for (uint8 c = 0; c < 4; ++c) {
                // A fresh observation per value: close times one second apart.
                uint64 close = CLOSE + uint64(i);
                vm.warp(close);
                src.setSigned(values[i], close);
                Outcome o = _resolve(_p(STAMPED, threshold, c, LOCK, close, WINDOW));
                assertEq(uint8(o), uint8(expected[c][i] ? Outcome.Yes : Outcome.No));
            }
        }
    }

    /// A snapshot can be taken exactly at the timestamps inside [close, close + window].
    function testFuzz_windowTiming(uint256 at, uint32 window) public {
        window = uint32(bound(window, 60, 1800));
        at = bound(at, NOW_TS, uint256(CLOSE) + 2 * 1800);
        vm.warp(at);
        bool inside = at >= CLOSE && at <= uint256(CLOSE) + window;
        try resolver.snapshot(PLAIN, CLOSE, window) returns (int256 v) {
            assertTrue(inside, "snapshot outside its window");
            assertEq(v, 42);
        } catch {
            assertFalse(inside, "refused a snapshot inside its window");
        }
        (Outcome o,) = resolver.resolve(_p(PLAIN, 41, 0, LOCK, CLOSE, window), "");
        assertEq(uint8(o), uint8(inside ? Outcome.Yes : Outcome.Unresolved));
    }

    /// validate accepts exactly the windows from one to thirty minutes.
    function testFuzz_validateSnapshotWindow(uint32 window) public view {
        window = uint32(bound(window, 0, 7200));
        bool ok = window >= 60 && window <= 1800;
        try resolver.validate(_p(OI, 0, 0, LOCK, CLOSE, window)) returns (Window memory w) {
            assertTrue(ok, "accepted a bad window");
            assertEq(w.settleDeadline, uint256(CLOSE) + window + 7 days);
        } catch {
            assertFalse(ok, "rejected a good window");
        }
    }

    /// Once taken, a snapshot never changes, whatever the source does and whoever calls.
    function testFuzz_snapshotIsFinal(uint256 first, uint256 later, uint256 dt, address caller) public {
        first = bound(first, 0, uint256(type(int256).max));
        later = bound(later, 0, uint256(type(int256).max));
        dt = bound(dt, 0, 30 days);
        vm.warp(CLOSE);
        src.setPlain(first);
        resolver.snapshot(PLAIN, CLOSE, WINDOW);
        vm.warp(uint256(CLOSE) + dt);
        src.setPlain(later);
        vm.prank(caller);
        try resolver.snapshot(PLAIN, CLOSE, WINDOW) {
            fail();
        } catch {}
        _resolve(_q(PLAIN, 0, 0));
        Snapshot memory s = _stored(PLAIN);
        assertEq(s.value, int256(first));
        assertEq(s.timestamp, CLOSE);
    }
}
