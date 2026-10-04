// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {Outcome, Window} from "../interfaces/IHunchBookTypes.sol";
import {PerplFundingParams} from "../interfaces/ITemplates.sol";
import {IPerplExchange} from "../interfaces/external/IPerplExchange.sol";
import {PerplReader} from "./PerplReader.sol";
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
///      Implementation changes: this resolver pins Perpl's `getContractVersion()` at its deployment
///      (see PerplReader, which it shares with template 4). `validate` refuses new markets once the
///      live version differs; `resolve` returns `Unresolved` if it differs. The check also covers
///      the time from creation to settlement, which is wider than the observation window, so a
///      version change after `endBlock` but before settlement voids the market too. The keeper
///      settles right after `endBlock` to keep that gap short.
///
///      evidenceHash, for the settlement verifier: keccak256(abi.encode(address exchange,
///      uint256 perpId, uint64 startBlock, uint64 endBlock, int48 F(start), int48 F(end),
///      uint256 eventBlock(start), uint256 eventBlock(end))).
contract PerplFundingResolver is IResolver, PerplReader {
    // Every error this resolver can revert with. PerplReader reverts with file-level errors of the
    // same signatures (so the same selectors); declaring them here lists them in this contract's ABI
    // and lets callers write `PerplFundingResolver.Error.selector`.
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
    constructor(IPerplExchange exchange_, uint256 blockTimeMs_) PerplReader(exchange_, blockTimeMs_) {}

    // ---------------------------------------------------------------- IResolver

    /// @inheritdoc IResolver
    function validate(bytes calldata params) external view returns (Window memory window) {
        PerplFundingParams memory p = abi.decode(params, (PerplFundingParams));
        // One encoding per question, so the factory's (template, params) key is unique per question.
        if (keccak256(abi.encode(p)) != keccak256(params)) revert NonCanonicalParams();
        _checkNewMarket(p.perpId, p.startBlock, p.endBlock, p.expectedScalingExp);
        // Round the time to endBlock up, then add the settlement window.
        window = Window({
            blockClock: true, lock: p.startBlock, close: p.endBlock, settleDeadline: _settleDeadline(p.endBlock)
        });
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

    // ---------------------------------------------------------------- internals

    function _read(PerplFundingParams memory p) internal view returns (Outcome, bytes32) {
        // Perpl can overwrite a scheduled funding value until its event block passes. Once
        // block.number > endBlock, every event at or before endBlock is final.
        if (block.number <= p.endBlock) return (Outcome.Unresolved, bytes32(0));

        // The pinned version, and the perp still at this id with the units recorded at creation and
        // not listed again since the window started.
        (bool intact, uint256 interval) = _sourceIntact(p.perpId, p.startBlock, p.expectedScalingExp);
        if (!intact) return (Outcome.Unresolved, bytes32(0));
        return _readWindow(p, interval);
    }

    /// F(startBlock) and F(endBlock), once the source is known to be intact.
    function _readWindow(PerplFundingParams memory p, uint256 interval) internal view returns (Outcome, bytes32) {
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
}
