// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {PerplFundingParams} from "../interfaces/ITemplates.sol";
import {IPerplExchange} from "../interfaces/external/IPerplExchange.sol";
import {ResolverText} from "./ResolverText.sol";

/// @title Template S-1: net funding on a Perpl perpetual (docs/PROTOCOL.md §6.1)
/// @notice "Will longs pay more than X in funding on Perpl perp P between block A and block B?"
///         ΔF = F(B) − F(A), where F is Perpl's cumulative funding sum read with
///         `getFundingSumAtBlock`. YES if ΔF > X, NO otherwise (equal is NO). X is in Perpl's raw
///         units; dividing by 10^(priceDecimals + fundingSumScalingExp) gives USD per unit of the asset.
/// @dev A pure reader: no storage, no owner, no funds. Every external read in `resolve` is wrapped so
///      that a failure can only ever produce `Unresolved` (the market then voids at its deadline), never
///      an outcome. An outcome needs every read to succeed and every check to pass.
///
///      Implementation changes. Perpl's Exchange is an ERC-1967/UUPS proxy. A contract cannot read
///      another contract's storage, so the ERC-1967 implementation slot is invisible onchain; the proxy
///      has no `implementation()` getter, and `proxiableUUID()` reverts when called through the proxy.
///      The only implementation identity Perpl exposes to contracts is `getContractVersion()`, which
///      Perpl stamps inside each upgrade transaction (event `ContractVersionSet`). The market's
///      parameters have no field to record it and `validate` is a view, so this resolver pins the
///      version at its own deployment instead:
///      - `validate` refuses new markets once the live version differs from the pinned one (a new
///        resolver, registered as a new template, is needed after a Perpl upgrade);
///      - `resolve` returns `Unresolved` if the live version differs from the pinned one.
///      Limits, stated plainly: an upgrade that keeps the same version number, or an upgrade and a
///      rollback that both happen between creation and settlement, cannot be detected onchain. The
///      keeper watches the implementation slot offchain (eth_getStorageAt) and reports such events.
///      The check also covers the time from creation to settlement, which is wider than the
///      observation window, so a version change after `endBlock` but before settlement voids the
///      market too. The keeper settles right after `endBlock` to keep that gap short.
///
///      evidenceHash, for the settlement verifier: keccak256(abi.encode(address exchange,
///      uint256 perpId, uint64 startBlock, uint64 endBlock, int48 F(start), int48 F(end),
///      uint256 eventBlock(start), uint256 eventBlock(end))).
contract PerplFundingResolver is IResolver {
    /// Settlement stays open this long after the estimated close (docs/PROTOCOL.md §2).
    uint256 public constant SETTLEMENT_WINDOW = 7 days;

    /// `resolve` refuses if the last funding event at or before `endBlock` is older than this many
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

    /// Conservative milliseconds per block. Used only to turn `endBlock` into an estimated unix
    /// time for the settlement deadline; it never affects an outcome.
    uint256 public immutable blockTimeMs;

    /// Perpl's `getContractVersion()` when this resolver was deployed (v1.<major>.<minor>.<patch>).
    uint256 public immutable versionMajor;
    uint256 public immutable versionMinor;
    uint256 public immutable versionPatch;

    error NotAContract(address account);
    error BlockTimeTooLow(uint256 blockTimeMs, uint256 minimum);
    error NonCanonicalParams();
    error ExchangeVersionChanged(uint256 major, uint256 minor, uint256 patch);
    error PerpNotListed(uint256 perpId);
    error PerpPaused(uint256 perpId);
    error FundingNotStarted(uint256 perpId, uint256 fundingStartBlock, uint64 startBlock);
    error ScalingExpMismatch(uint256 expected, uint256 actual);
    error StartBlockNotInFuture(uint64 startBlock, uint256 currentBlock);
    error WindowTooShort(uint64 startBlock, uint64 endBlock, uint256 fundingInterval);
    error DeadlineOverflow();
    error EvidenceNotEmpty();

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

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        PerplFundingParams memory p = abi.decode(params, (PerplFundingParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();

        (uint256 major, uint256 minor, uint256 patch) = exchange.getContractVersion();
        if (!_isPinned(major, minor, patch)) revert ExchangeVersionChanged(major, minor, patch);

        if (p.startBlock <= block.number) revert StartBlockNotInFuture(p.startBlock, block.number);
        if (!isListed(p.perpId)) revert PerpNotListed(p.perpId);

        IPerplExchange.PerpetualInfoV2 memory info = exchange.getPerpetualInfoV2(p.perpId);
        if (info.status == PERP_STATUS_PAUSED) revert PerpPaused(p.perpId);
        if (info.fundingSumScalingExp != p.expectedScalingExp) {
            revert ScalingExpMismatch(p.expectedScalingExp, info.fundingSumScalingExp);
        }
        // Funding must already run at the window's start. `resolve` relies on this to detect an id
        // that was removed and listed again during the window (its funding start block moves).
        if (info.fundingStartBlock == 0 || info.fundingStartBlock > p.startBlock) {
            revert FundingNotStarted(p.perpId, info.fundingStartBlock, p.startBlock);
        }

        uint256 interval = exchange.getFundingInterval();
        if (p.endBlock <= p.startBlock || p.endBlock - p.startBlock < interval) {
            revert WindowTooShort(p.startBlock, p.endBlock, interval);
        }

        // Round the time to endBlock up, then add the settlement window.
        uint256 msToEnd = (uint256(p.endBlock) - block.number) * blockTimeMs;
        uint256 deadline = block.timestamp + (msToEnd + 999) / 1000 + SETTLEMENT_WINDOW;
        // An overflow guard, not a timing rule.
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline > type(uint64).max) revert DeadlineOverflow();

        // Safe: bounded by type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        window = Window({blockClock: true, lock: p.startBlock, close: p.endBlock, settleDeadline: uint64(deadline)});
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        PerplFundingParams memory p = abi.decode(params, (PerplFundingParams));
        string memory blocks = string.concat(
            " between block ", LibString.toString(p.startBlock), " and block ", LibString.toString(p.endBlock), "?"
        );
        try exchange.getPerpetualInfoV2(p.perpId) returns (IPerplExchange.PerpetualInfoV2 memory info) {
            string memory venue =
                string.concat(" in funding on Perpl (", info.name, ", perp ", LibString.toString(p.perpId), ")");
            if (p.threshold == 0) {
                return string.concat("Will ", info.symbol, " longs pay shorts on net", venue, blocks);
            }
            uint256 decimals = info.priceDecimals + p.expectedScalingExp;
            return string.concat(
                "Will ",
                info.symbol,
                " longs pay more than ",
                ResolverText.usd(p.threshold, decimals),
                " per ",
                info.symbol,
                venue,
                blocks
            );
        } catch {
            return string.concat(
                "Will longs on Perpl perp ",
                LibString.toString(p.perpId),
                " pay more than ",
                ResolverText.signedDecimal(p.threshold, 0),
                " raw funding units",
                blocks
            );
        }
    }

    /// @inheritdoc IResolver
    /// @dev `evidence` must be empty: the resolver reads Perpl itself. Any ETH sent is returned.
    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash)
    {
        if (evidence.length != 0) revert EvidenceNotEmpty();
        PerplFundingParams memory p = abi.decode(params, (PerplFundingParams));
        (outcome, evidenceHash) = _read(p);
        if (msg.value != 0) SafeTransferLib.safeTransferETH(msg.sender, msg.value);
    }

    /// @inheritdoc IResolver
    function earlyYes() external pure returns (bool) {
        return false;
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

    function _read(PerplFundingParams memory p) internal view returns (Outcome, bytes32) {
        // Perpl can overwrite a scheduled funding value until its event block passes. Once
        // block.number > endBlock, every event at or before endBlock is final.
        if (block.number <= p.endBlock) return (Outcome.Unresolved, bytes32(0));
        if (!versionUnchanged()) return (Outcome.Unresolved, bytes32(0));

        // The perp must still exist at this id with the units recorded at creation, and the id must
        // not have been listed again since the window started.
        try exchange.getPerpetualInfoV2(p.perpId) returns (IPerplExchange.PerpetualInfoV2 memory info) {
            if (info.fundingSumScalingExp != p.expectedScalingExp) return (Outcome.Unresolved, bytes32(0));
            if (info.fundingStartBlock == 0 || info.fundingStartBlock > p.startBlock) {
                return (Outcome.Unresolved, bytes32(0));
            }
        } catch {
            return (Outcome.Unresolved, bytes32(0));
        }

        uint256 interval = 0;
        try exchange.getFundingInterval() returns (uint256 i) {
            interval = i;
        } catch {
            return (Outcome.Unresolved, bytes32(0));
        }
        if (interval == 0) return (Outcome.Unresolved, bytes32(0));

        (bool okStart, int48 sumStart, uint256 eventStart) = _fundingSum(p.perpId, p.startBlock);
        (bool okEnd, int48 sumEnd, uint256 eventEnd) = _fundingSum(p.perpId, p.endBlock);
        if (!okStart || !okEnd) return (Outcome.Unresolved, bytes32(0));

        // The getter promises an event at or before the block asked for; anything else is not data
        // this resolver can vouch for.
        if (eventStart > p.startBlock || eventEnd > p.endBlock || eventEnd < eventStart) {
            return (Outcome.Unresolved, bytes32(0));
        }
        // Paused perp: no funding event in the last two intervals before endBlock.
        if (p.endBlock - eventEnd > MAX_STALE_INTERVALS * interval) return (Outcome.Unresolved, bytes32(0));

        int256 delta = int256(sumEnd) - int256(sumStart);
        Outcome outcome = delta > p.threshold ? Outcome.Yes : Outcome.No;
        bytes32 evidenceHash = keccak256(
            abi.encode(address(exchange), p.perpId, p.startBlock, p.endBlock, sumStart, sumEnd, eventStart, eventEnd)
        );
        return (outcome, evidenceHash);
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
