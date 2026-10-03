// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Shared types for every Hunch Book contract. Frozen as v0 (docs/PROTOCOL.md §7.2).

/// What a market can do right now. `PoolLocked` and `Closed` are derived from the clock.
enum Phase {
    Pool, // staking open, graduation possible
    PoolLocked, // staking stopped, never graduated; settles as a pool
    Graduated, // tokens claimable, trading and minting open
    Closed, // graduated and past close: settle, merge, claim
    Settled, // final outcome known
    Voided // no answer before the settlement deadline
}

enum Side {
    Yes,
    No
}

enum Outcome {
    Unresolved,
    Yes,
    No
}

/// The market's clock. Perpl markets run on block numbers, price markets on unix seconds.
struct Window {
    bool blockClock; // true: lock and close are block numbers; false: unix seconds
    uint64 lock; // staking and graduation stop
    uint64 close; // observation ends, settlement opens
    uint64 settleDeadline; // unix seconds; void allowed after this, settlement allowed up to it
}

/// Copied from the template into each market at creation; never changes for that market.
struct GraduationRule {
    uint128 minPool; // USDC base units
    uint32 minStakers; // distinct addresses across both sides
    uint16 minChanceBps; // 300 = 3%
    uint16 maxChanceBps; // 9700 = 97%
}

/// Per-market limits, copied from the factory at creation; never change for that market.
struct MarketCaps {
    uint128 poolCap; // max USDC in the pool, and the Kuru book's maxSize
    uint128 walletCap; // max USDC one address can stake in this market (both sides together)
    uint128 minStake; // min USDC per stake
    uint128 creatorMinStake; // min first stake by the creator
}
