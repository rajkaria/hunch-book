// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Parameter schema for template 7 (docs/TEMPLATES.md), and the types its resolver exposes. A market's
/// `params` is `abi.encode(SnapshotParams)`. Templates 1 and 2 are in ITemplates.sol and templates 3
/// to 6 in ITemplatesV2.sol; both files are frozen. The app, keeper and indexer decode with these.

/// Template 7, snapshot: "Will `source` read above (or at or above, below, at or below) `threshold`
/// in the first snapshot taken in [closeTime, closeTime + snapshotWindow]?"
/// For values a contract exposes only as current state (Perpl open interest and mark price), which no
/// contract can read for a past block. Anyone takes the snapshot, once, inside the window: the resolver
/// makes the source's fixed view call itself and stores the value. The first snapshot is final, and
/// every market with the same source, close time and window answers from it. With no snapshot in the
/// window the market has no answer and voids at its deadline.
struct SnapshotParams {
    uint16 sourceId; // index in the resolver's source list, fixed when the resolver was deployed
    int256 threshold; // in the source's raw units: the value shown is raw / 10^decimals, in `unit`
    uint8 comparator; // 0 = above, 1 = at or above, 2 = below, 3 = at or below
    uint64 lockTime; // unix seconds: staking stops
    uint64 closeTime; // unix seconds: the snapshot window opens
    uint32 snapshotWindow; // seconds: the window's length, 60 to 1,800 (10 minutes is the default)
}

/// One value a snapshot market can be about: a fixed view call, where the value sits in its return
/// data, and the checks that it still means what it meant when the resolver was deployed. Written
/// once, in the resolver's constructor; there is no way to add, change or remove a source later.
/// Word indexes count 32-byte words from the start of the return data, or from the start of the
/// returned tuple when `tuple` is set.
struct SnapshotSource {
    string label; // what the value is, for the rule sentence: "Perpl's BTC open interest (perp 1)"
    string unit; // what the value is counted in: "BTC", or "USD" for a dollar amount
    uint8 decimals; // the value is shown as raw / 10^decimals
    address target; // the contract called, with STATICCALL
    bytes callData; // the call: selector and arguments, fixed
    bool tuple; // the return is one dynamic tuple (a struct with strings): word 0 points at its head
    uint16 valueWord; // the value's word
    bool signed; // the value is a two's complement signed integer; otherwise unsigned
    uint16 timestampWord; // the word holding when the value was last updated, in unix seconds
    uint32 maxAge; // a value older than this many seconds is refused; 0 = the value has no timestamp
    uint16[] pinnedWords; // words of the same return that must read as they did at deployment
    address guardTarget; // an extra contract whose answer to `guardCallData` must not change; 0 = none
    bytes guardCallData; // for Perpl: getContractVersion(), the implementation's version
}

/// A stored snapshot. `blockNumber == 0` means none has been taken.
struct Snapshot {
    int256 value; // the raw value read
    uint64 blockNumber; // the block of the snapshot transaction
    uint64 timestamp; // that block's timestamp
}

/// Never deployed. Exists so the parameter struct appears in an ABI that TypeScript can encode with.
interface ITemplateParamsCodecV3 {
    function snapshot(SnapshotParams calldata params) external pure;
}

/// Evidence format passed to `IResolver.resolve` and `IMarket.settle`.
/// Template 7: empty. The resolver answers from the stored snapshot, and if `settle` is called inside
///             the window before anyone has taken one, it takes the snapshot itself first.
