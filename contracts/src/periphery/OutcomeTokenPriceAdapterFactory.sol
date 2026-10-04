// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibClone} from "solady/utils/LibClone.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {Side} from "../interfaces/IHunchBookTypes.sol";
import {IImpliedProbabilityOracle} from "./interfaces/IImpliedProbabilityOracle.sol";
import {IOutcomeTokenPriceAdapterFactory} from "./interfaces/IOutcomeTokenPriceAdapterFactory.sol";
import {OutcomeTokenPriceAdapter} from "./OutcomeTokenPriceAdapter.sol";

/// @title OutcomeTokenPriceAdapterFactory
/// @notice Deploys OutcomeTokenPriceAdapters with CREATE2 (salt = keccak256(abi.encode(market, side))),
/// so each (market, side) has one adapter at an address known in advance. The parameters are fixed
/// at deployment and shared by every adapter; a different set of parameters is a different factory.
/// No owner.
contract OutcomeTokenPriceAdapterFactory is IOutcomeTokenPriceAdapterFactory {
    uint256 internal constant BPS = 10_000;

    /// @inheritdoc IOutcomeTokenPriceAdapterFactory
    address public immutable oracle;
    /// @inheritdoc IOutcomeTokenPriceAdapterFactory
    address public immutable vault;
    /// The Hunch Book factory the oracle reads.
    address public immutable hunchFactory;

    AdapterParams internal _params;

    /// @inheritdoc IOutcomeTokenPriceAdapterFactory
    mapping(address market => mapping(Side side => address)) public adapterOf;

    /// @param oracle_ The ImpliedProbabilityOracle every adapter reads.
    /// @param p Shared parameters. Requires 0 < twapWindow <= oracle maxWindow(), baseHaircutBps <=
    ///        closeHaircutBps <= 10000, maxSpreadHaircutBps <= 10000, rampSeconds > 0, blockTimeMs > 0.
    constructor(IImpliedProbabilityOracle oracle_, AdapterParams memory p) {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        if (
            p.twapWindow == 0 || p.twapWindow > oracle_.maxWindow() || p.baseHaircutBps > p.closeHaircutBps
                || p.closeHaircutBps > BPS || p.maxSpreadHaircutBps > BPS || p.rampSeconds == 0 || p.blockTimeMs == 0
        ) revert BadParams();
        address hunch = oracle_.factory();
        address vault_ = IHunchBookFactory(hunch).vault();
        if (hunch == address(0) || vault_ == address(0)) revert ZeroAddress();
        oracle = address(oracle_);
        hunchFactory = hunch;
        vault = vault_;
        _params = p;
    }

    /// @inheritdoc IOutcomeTokenPriceAdapterFactory
    function createAdapter(address market, Side side) external returns (address adapter) {
        if (!IHunchBookFactory(hunchFactory).isMarket(market)) revert UnknownMarket();
        address existing = adapterOf[market][side];
        if (existing != address(0)) revert AdapterExists(existing);
        adapter = address(new OutcomeTokenPriceAdapter{salt: _salt(market, side)}(market, side));
        adapterOf[market][side] = adapter;
        emit AdapterCreated(market, side, adapter);
    }

    /// @inheritdoc IOutcomeTokenPriceAdapterFactory
    function predictAdapter(address market, Side side) external view returns (address) {
        // Init code = creation code followed by the ABI-encoded constructor arguments, as CREATE2 hashes it.
        // forge-lint: disable-next-line(encode-packed-collision)
        bytes memory initCode = abi.encodePacked(type(OutcomeTokenPriceAdapter).creationCode, abi.encode(market, side));
        return LibClone.predictDeterministicAddress(keccak256(initCode), _salt(market, side), address(this));
    }

    /// @inheritdoc IOutcomeTokenPriceAdapterFactory
    function params() external view returns (AdapterParams memory) {
        return _params;
    }

    function _salt(address market, Side side) internal pure returns (bytes32) {
        return keccak256(abi.encode(market, side));
    }
}
