// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {PerplFundingSpikeParams} from "../interfaces/ITemplatesV2.sol";
import {IPerplExchange} from "../interfaces/external/IPerplExchange.sol";
import {PerplReader} from "./PerplReader.sol";
import {ResolverText} from "./ResolverText.sol";

/// @title Template 4: a single-interval funding spike on a Perpl perpetual (docs/PROTOCOL.md §6.3)
/// @notice "Will any single funding event on Perpl perp P after block A and at or before block B charge
///         longs more than X?" F is Perpl's cumulative funding sum (`getFundingSumAtBlock`); a rising
///         sum means longs paid shorts. X is in Perpl's raw units for one event; dividing by
///         10^(priceDecimals + fundingSumScalingExp) gives USD per unit of the asset.
///         - YES is proved by pointing at the event: evidence abi.encode(uint64 e). Accepted only if
///           A < e <= B, e < block.number (Perpl can rewrite a scheduled value until its block passes),
///           Perpl reports e itself as the last event at or before e, the last event before e is
///           exactly one funding interval earlier (e − interval, so nothing else happened in between),
///           and F(e) − F(e − interval) > X. Equal is not a spike. A pointer that fails any of these
///           reverts, so a bad proof can never settle anything.
///         - NO needs no proof: empty evidence settles NO once `block.number > B + challengeBlocks`
///           (about 24 hours after B) with no proof, if the source is still intact and the perp was
///           not paused at the end of the window (its last event at or before B is at most two
///           intervals old). Otherwise empty evidence is `Unresolved`.
///         The assumption, stated plainly: if a spike exists, at least one honest party (Hunch's
///         keeper, or anyone) submits it within the challenge period.
/// @dev A pure reader: no storage, no owner, no funds. Shares PerplReader with template 1: the same
///      version pin, scaling and relisting checks, and the same refusal rules. `challengeBlocks` is
///      fixed at deployment as the number of blocks in 24 hours at the block time measured then; if
///      blocks later get faster the period gets shorter in wall time, so a much faster chain needs a
///      new resolver (template).
///
///      evidenceHash, for the settlement verifier:
///      - YES: keccak256(abi.encode(address exchange, uint256 perpId, uint64 e, int48 F(e),
///        uint256 previousEventBlock, int48 F(previous)))
///      - NO: keccak256(abi.encode(address exchange, uint256 perpId, uint64 endBlock,
///        uint256 challengeEndBlock, uint256 lastEventBlock, int48 F(lastEvent)))
contract PerplFundingSpikeResolver is IResolver, PerplReader {
    /// Floor for `challengeBlocks`: a day at one block per second. Monad has always been faster, so
    /// the real figure is higher.
    uint256 public constant MIN_BLOCKS_PER_DAY = 86_400;

    /// The longest observation window, in days of blocks.
    uint256 public constant MAX_WINDOW_DAYS = 31;

    /// Blocks in the 24-hour challenge period, at the block time measured at deployment.
    uint256 public immutable challengeBlocks;

    // Every error this resolver can revert with. PerplReader reverts with file-level errors of the
    // same signatures (so the same selectors); declaring them here lists them in this contract's ABI
    // and lets callers write `PerplFundingSpikeResolver.Error.selector`.
    error NotAContract(address account);
    error BlockTimeTooLow(uint256 blockTimeMs, uint256 minimum);
    error BlocksPerDayTooLow(uint256 blocksPerDay, uint256 minimum);
    error NonCanonicalParams();
    error ExchangeVersionChanged(uint256 major, uint256 minor, uint256 patch);
    error PerpNotListed(uint256 perpId);
    error PerpPaused(uint256 perpId);
    error FundingNotStarted(uint256 perpId, uint256 fundingStartBlock, uint64 startBlock);
    error ScalingExpMismatch(uint256 expected, uint256 actual);
    error StartBlockNotInFuture(uint64 startBlock, uint256 currentBlock);
    error WindowTooShort(uint64 startBlock, uint64 endBlock, uint256 fundingInterval);
    error WindowTooLong(uint64 startBlock, uint64 endBlock, uint256 maxBlocks);
    error DeadlineOverflow();
    error MalformedEvidence();
    error EventOutsideWindow(uint64 eventBlock, uint64 startBlock, uint64 endBlock);
    error EventNotFinal(uint64 eventBlock, uint256 currentBlock);
    error FundingReadFailed(uint256 blockNumber);
    error NotAFundingEvent(uint64 eventBlock, uint256 reportedEventBlock);
    error NotOneInterval(uint64 eventBlock, uint256 previousEventBlock, uint256 fundingInterval);
    error NotASpike(uint64 eventBlock, int256 increment, int256 threshold);

    /// @param exchange_ Perpl's Exchange proxy.
    /// @param blockTimeMs_ conservative milliseconds per block, for settlement deadlines only (at least
    ///        `MIN_BLOCK_TIME_MS`).
    /// @param blocksPerDay_ blocks in 24 hours at today's block time: the challenge period in blocks.
    constructor(IPerplExchange exchange_, uint256 blockTimeMs_, uint256 blocksPerDay_)
        PerplReader(exchange_, blockTimeMs_)
    {
        if (blocksPerDay_ < MIN_BLOCKS_PER_DAY) revert BlocksPerDayTooLow(blocksPerDay_, MIN_BLOCKS_PER_DAY);
        challengeBlocks = blocksPerDay_;
    }

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        PerplFundingSpikeParams memory p = abi.decode(params, (PerplFundingSpikeParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        _checkNewMarket(p.perpId, p.startBlock, p.endBlock, p.expectedScalingExp);
        uint256 maxBlocks = MAX_WINDOW_DAYS * challengeBlocks;
        if (p.endBlock - p.startBlock > maxBlocks) revert WindowTooLong(p.startBlock, p.endBlock, maxBlocks);
        // NO can only settle after the challenge period, so the deadline counts from its end.
        window = Window({
            blockClock: true,
            lock: p.startBlock,
            close: p.endBlock,
            settleDeadline: _settleDeadline(uint256(p.endBlock) + challengeBlocks)
        });
    }

    /// @inheritdoc IResolver
    function describe(bytes calldata params) external view returns (string memory) {
        PerplFundingSpikeParams memory p = abi.decode(params, (PerplFundingSpikeParams));
        string memory window = string.concat(
            " after block ",
            LibString.toString(p.startBlock),
            " and at or before block ",
            LibString.toString(p.endBlock)
        );
        string memory no = string.concat(
            "; NO if nobody proves one by block ",
            LibString.toString(uint256(p.endBlock) + challengeBlocks),
            ", about 24 hours after the window."
        );
        try exchange.getPerpetualInfoV2(p.perpId) returns (IPerplExchange.PerpetualInfoV2 memory info) {
            return string.concat(
                "YES if any single funding event on Perpl (",
                info.name,
                ", perp ",
                LibString.toString(p.perpId),
                ")",
                window,
                " charges ",
                info.symbol,
                " longs more than ",
                ResolverText.usd(p.threshold, info.priceDecimals + p.expectedScalingExp),
                " per ",
                info.symbol,
                no
            );
        } catch {
            return string.concat(
                "YES if any single funding event on Perpl perp ",
                LibString.toString(p.perpId),
                window,
                " charges longs more than ",
                ResolverText.signedDecimal(p.threshold, 0),
                " raw funding units",
                no
            );
        }
    }

    /// @inheritdoc IResolver
    /// @dev Proof: evidence = abi.encode(uint64 eventBlock). NO: empty evidence. Any ETH sent is returned.
    function resolve(bytes calldata params, bytes calldata evidence)
        external
        payable
        returns (Outcome outcome, bytes32 evidenceHash)
    {
        PerplFundingSpikeParams memory p = abi.decode(params, (PerplFundingSpikeParams));
        (outcome, evidenceHash) = evidence.length == 0 ? _resolveNo(p) : _resolveProof(p, evidence);
        if (msg.value != 0) SafeTransferLib.safeTransferETH(msg.sender, msg.value);
    }

    /// @inheritdoc IResolver
    function earlyYes() external pure returns (bool) {
        return true;
    }

    // ---------------------------------------------------------------- internals

    /// YES if the event at `e` is a single-interval spike inside the window; reverts if the pointer is
    /// wrong; `Unresolved` if the source is no longer the one the market was created on.
    function _resolveProof(PerplFundingSpikeParams memory p, bytes calldata evidence)
        internal
        view
        returns (Outcome, bytes32)
    {
        if (evidence.length != 32) revert MalformedEvidence();
        uint64 e = abi.decode(evidence, (uint64));
        if (e <= p.startBlock || e > p.endBlock) revert EventOutsideWindow(e, p.startBlock, p.endBlock);
        if (e >= block.number) revert EventNotFinal(e, block.number);

        (bool intact, uint256 interval) = _sourceIntact(p.perpId, p.startBlock, p.expectedScalingExp);
        if (!intact) return (Outcome.Unresolved, bytes32(0));
        if (e <= interval) revert NotOneInterval(e, 0, interval);

        (int48 sum, uint256 eventBlock) = _proofRead(p.perpId, e);
        if (eventBlock != e) revert NotAFundingEvent(e, eventBlock);

        // The last event strictly before e must sit exactly one interval back: then F(e) − F(prev)
        // is the increment of the single event at e.
        (int48 sumPrev, uint256 prev) = _proofRead(p.perpId, e - 1);
        if (prev != e - interval) revert NotOneInterval(e, prev, interval);

        int256 increment = int256(sum) - int256(sumPrev);
        if (increment <= p.threshold) revert NotASpike(e, increment, p.threshold);
        return (Outcome.Yes, keccak256(abi.encode(address(exchange), p.perpId, e, sum, prev, sumPrev)));
    }

    /// A read a proof depends on: a failure means the pointer cannot be checked, so the proof reverts.
    function _proofRead(uint256 perpId, uint256 blockNumber) internal view returns (int48, uint256) {
        (bool ok, int48 sum, uint256 eventBlock) = _fundingSum(perpId, blockNumber);
        if (!ok) revert FundingReadFailed(blockNumber);
        return (sum, eventBlock);
    }

    /// NO once the challenge period is over, the source is intact and funding was live at the end of
    /// the window.
    function _resolveNo(PerplFundingSpikeParams memory p) internal view returns (Outcome, bytes32) {
        uint256 challengeEnd = uint256(p.endBlock) + challengeBlocks;
        if (block.number <= challengeEnd) return (Outcome.Unresolved, bytes32(0));

        (bool intact, uint256 interval) = _sourceIntact(p.perpId, p.startBlock, p.expectedScalingExp);
        if (!intact) return (Outcome.Unresolved, bytes32(0));

        (bool ok, int48 sumEnd, uint256 eventEnd) = _fundingSum(p.perpId, p.endBlock);
        if (!ok || eventEnd > p.endBlock) return (Outcome.Unresolved, bytes32(0));
        // Paused perp: no funding event in the last two intervals before endBlock.
        if (p.endBlock - eventEnd > MAX_STALE_INTERVALS * interval) return (Outcome.Unresolved, bytes32(0));

        return
            (Outcome.No, keccak256(abi.encode(address(exchange), p.perpId, p.endBlock, challengeEnd, eventEnd, sumEnd)));
    }
}
