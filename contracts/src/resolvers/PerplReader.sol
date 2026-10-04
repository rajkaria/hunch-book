// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPerplExchange} from "../interfaces/external/IPerplExchange.sol";

// File-level errors, so each concrete resolver can declare the same errors as its own members and
// expose them as `Resolver.Error` (a contract's type does not list errors it inherits). Same
// signature, same selector.
error NotAContract(address account);
error BlockTimeTooLow(uint256 blockTimeMs, uint256 minimum);
error ExchangeVersionChanged(uint256 major, uint256 minor, uint256 patch);
error PerpNotListed(uint256 perpId);
error PerpPaused(uint256 perpId);
error FundingNotStarted(uint256 perpId, uint256 fundingStartBlock, uint64 startBlock);
error ScalingExpMismatch(uint256 expected, uint256 actual);
error StartBlockNotInFuture(uint64 startBlock, uint256 currentBlock);
error WindowTooShort(uint64 startBlock, uint64 endBlock, uint256 fundingInterval);
error DeadlineOverflow();

/// @title Perpl Exchange reads shared by templates 1 (net funding) and 4 (funding spike)
/// @notice Perpl's cumulative funding sum F is read with `getFundingSumAtBlock`, which returns the sum
///         as of the last funding event at or before a block, and that event's block. History is kept
///         in contract storage, so old blocks stay readable at the head.
/// @dev Implementation changes. Perpl's Exchange is an ERC-1967/UUPS proxy. A contract cannot read
///      another contract's storage, so the ERC-1967 implementation slot is invisible onchain; the proxy
///      has no `implementation()` getter, and `proxiableUUID()` reverts when called through the proxy.
///      The only implementation identity Perpl exposes to contracts is `getContractVersion()`, which
///      Perpl stamps inside each upgrade transaction (event `ContractVersionSet`). The market's
///      parameters have no field to record it and `validate` is a view, so a resolver pins the
///      version at its own deployment instead:
///      - `validate` refuses new markets once the live version differs from the pinned one (a new
///        resolver, registered as a new template, is needed after a Perpl upgrade);
///      - `resolve` refuses to answer if the live version differs from the pinned one.
///      Limits, stated plainly: an upgrade that keeps the same version number, or an upgrade and a
///      rollback that both happen between creation and settlement, cannot be detected onchain. The
///      keeper watches the implementation slot offchain (eth_getStorageAt) and reports such events.
abstract contract PerplReader {
    /// Settlement stays open this long after the estimated close (docs/PROTOCOL.md §2).
    uint256 public constant SETTLEMENT_WINDOW = 7 days;

    /// A read refuses if the last funding event at or before `endBlock` is older than this many
    /// funding intervals (the perp was paused, so its sum stopped moving).
    uint256 public constant MAX_STALE_INTERVALS = 2;

    /// Floor for `blockTimeMs`. Monad produces a block every 300 to 400 ms; the estimate must be at
    /// least twice that so the settlement deadline can never arrive before `endBlock` does.
    uint256 public constant MIN_BLOCK_TIME_MS = 800;

    /// Perpl's `PerpStatusEnum` value for a paused perp.
    uint8 internal constant PERP_STATUS_PAUSED = 0;

    /// Perpl ids live in a 4-word bitmap: 0..1023.
    uint256 internal constant MAX_PERP_ID = 1023;

    IPerplExchange public immutable exchange;

    /// Conservative milliseconds per block. Used only to turn a block number into an estimated unix
    /// time for the settlement deadline; it never affects an outcome.
    uint256 public immutable blockTimeMs;

    /// Perpl's `getContractVersion()` when this resolver was deployed (v1.<major>.<minor>.<patch>).
    uint256 public immutable versionMajor;
    uint256 public immutable versionMinor;
    uint256 public immutable versionPatch;

    /// @param exchange_ Perpl's Exchange proxy.
    /// @param blockTimeMs_ conservative milliseconds per block (at least `MIN_BLOCK_TIME_MS`).
    constructor(IPerplExchange exchange_, uint256 blockTimeMs_) {
        if (address(exchange_).code.length == 0) revert NotAContract(address(exchange_));
        if (blockTimeMs_ < MIN_BLOCK_TIME_MS) revert BlockTimeTooLow(blockTimeMs_, MIN_BLOCK_TIME_MS);
        exchange = exchange_;
        blockTimeMs = blockTimeMs_;
        (uint256 major, uint256 minor, uint256 patch) = exchange_.getContractVersion();
        versionMajor = major;
        versionMinor = minor;
        versionPatch = patch;
    }

    // ---------------------------------------------------------------- views

    /// True if Perpl lists `perpId` in its existence bitmap.
    function isListed(uint256 perpId) public view returns (bool) {
        if (perpId > MAX_PERP_ID) return false;
        uint256[4] memory bitmap = exchange.getPerpetualExistsBitmap();
        return (bitmap[perpId >> 8] >> (perpId & 0xff)) & 1 == 1;
    }

    /// True if Perpl's live version is the one pinned at deployment.
    function versionUnchanged() public view returns (bool) {
        try exchange.getContractVersion() returns (uint256 major, uint256 minor, uint256 patch) {
            return _isPinned(major, minor, patch);
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- internals

    /// The checks every new Perpl market must pass. Returns Perpl's funding interval in blocks.
    function _checkNewMarket(uint256 perpId, uint64 startBlock, uint64 endBlock, uint8 expectedScalingExp)
        internal
        view
        returns (uint256 interval)
    {
        (uint256 major, uint256 minor, uint256 patch) = exchange.getContractVersion();
        if (!_isPinned(major, minor, patch)) revert ExchangeVersionChanged(major, minor, patch);

        if (startBlock <= block.number) revert StartBlockNotInFuture(startBlock, block.number);
        if (!isListed(perpId)) revert PerpNotListed(perpId);

        IPerplExchange.PerpetualInfoV2 memory info = exchange.getPerpetualInfoV2(perpId);
        if (info.status == PERP_STATUS_PAUSED) revert PerpPaused(perpId);
        if (info.fundingSumScalingExp != expectedScalingExp) {
            revert ScalingExpMismatch(expectedScalingExp, info.fundingSumScalingExp);
        }
        // Funding must already run at the window's start. Reads rely on this to detect an id that
        // was removed and listed again during the window (its funding start block moves).
        if (info.fundingStartBlock == 0 || info.fundingStartBlock > startBlock) {
            revert FundingNotStarted(perpId, info.fundingStartBlock, startBlock);
        }

        interval = exchange.getFundingInterval();
        if (endBlock <= startBlock || endBlock - startBlock < interval) {
            revert WindowTooShort(startBlock, endBlock, interval);
        }
    }

    /// The estimated unix time of `untilBlock` (rounded up, at `blockTimeMs` per block) plus the
    /// settlement window. `untilBlock` must be in the future.
    function _settleDeadline(uint256 untilBlock) internal view returns (uint64) {
        uint256 msToEnd = (untilBlock - block.number) * blockTimeMs;
        uint256 deadline = block.timestamp + (msToEnd + 999) / 1000 + SETTLEMENT_WINDOW;
        // An overflow guard, not a timing rule.
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline > type(uint64).max) revert DeadlineOverflow();
        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(deadline);
    }

    /// True, with the funding interval, if the source is still the one the market was created on:
    /// the pinned version, the same perp at this id (funding started at or before `startBlock`) with
    /// the scaling recorded at creation, and a non-zero interval. Every read is wrapped, so a failure
    /// can only ever mean "no answer", never an outcome.
    function _sourceIntact(uint256 perpId, uint64 startBlock, uint8 expectedScalingExp)
        internal
        view
        returns (bool, uint256)
    {
        if (!versionUnchanged()) return (false, 0);
        try exchange.getPerpetualInfoV2(perpId) returns (IPerplExchange.PerpetualInfoV2 memory info) {
            if (info.fundingSumScalingExp != expectedScalingExp) return (false, 0);
            if (info.fundingStartBlock == 0 || info.fundingStartBlock > startBlock) return (false, 0);
        } catch {
            return (false, 0);
        }
        try exchange.getFundingInterval() returns (uint256 interval) {
            return (interval != 0, interval);
        } catch {
            return (false, 0);
        }
    }

    function _fundingSum(uint256 perpId, uint256 blockNumber)
        internal
        view
        returns (bool ok, int48 sum, uint256 eventBlock)
    {
        try exchange.getFundingSumAtBlock(perpId, blockNumber) returns (int48 s, uint256 e) {
            return (true, s, e);
        } catch {
            return (false, 0, 0);
        }
    }

    function _isPinned(uint256 major, uint256 minor, uint256 patch) internal view returns (bool) {
        return major == versionMajor && minor == versionMinor && patch == versionPatch;
    }
}
