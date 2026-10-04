// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {KuruMarketParams} from "../../../src/interfaces/external/IKuruOrderBook.sol";
import {MockKuruOrderBook} from "../../mocks/MockKuruOrderBook.sol";

/// MockKuruOrderBook with what the periphery tests need on top of it:
/// - `bestBidAsk()` as Kuru reports it: the best resting prices scaled to 1e18, an empty bid as
///   type(uint256).max and an empty ask as 0; or any pair a test sets (for AMM-vault prices,
///   sentinels and odd values), or a revert.
/// - `addAskFrom`: rests an ask funded with real YES pulled from a maker. The base mock mints its
///   ask liquidity, which a real OutcomeToken (mint only by the vault) does not allow. Bids still
///   mint quote, which TestUSDC's faucet allows.
contract PeripheryBook is MockKuruOrderBook {
    bool public bestOverridden;
    bool public bestReverts;
    uint256 internal _overrideBid;
    uint256 internal _overrideAsk;

    constructor(KuruMarketParams memory p, uint96 spread) MockKuruOrderBook(p, spread) {}

    /// Pulls `size` YES from `from` (which approved this book) and rests it as an ask.
    function addAskFrom(address from, uint32 price, uint96 size) external {
        _insert(_asks, _askHead, price, size, true);
        SafeTransferLib.safeTransferFrom(_p.baseAsset, from, address(this), size);
    }

    function setBestBidAsk(uint256 bid, uint256 ask) external {
        bestOverridden = true;
        _overrideBid = bid;
        _overrideAsk = ask;
    }

    function clearBestOverride() external {
        bestOverridden = false;
    }

    function setBestReverts(bool r) external {
        bestReverts = r;
    }

    function bestBidAsk() external view returns (uint256 bid, uint256 ask) {
        require(!bestReverts, "book unavailable");
        if (bestOverridden) return (_overrideBid, _overrideAsk);
        uint256 pP = _p.pricePrecision;
        bid = _bidHead < _bids.length ? uint256(_bids[_bidHead].price) * 1e18 / pP : type(uint256).max;
        ask = _askHead < _asks.length ? uint256(_asks[_askHead].price) * 1e18 / pP : 0;
    }
}
