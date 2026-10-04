// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {Outcome, Phase} from "../interfaces/IHunchBookTypes.sol";
import {IImpliedProbabilityOracle} from "./interfaces/IImpliedProbabilityOracle.sol";
import {BookPrice} from "./libraries/BookPrice.sol";

/// @title ImpliedProbabilityOracle
/// @notice Spot and time-weighted implied chance of YES for every Hunch Book market (roadmap V-6).
/// See IImpliedProbabilityOracle and docs/PERIPHERY.md.
///
/// Storage per market: the head (latest observation, rewritten by each poke) and a ring of
/// checkpoints (copies of the head, at least `MIN_SPACING` seconds apart). A recorded value applies
/// forward from its poke, so a value pushed onto the book and poked within one transaction counts
/// only until the next poke, which anyone can make in the next block. `consult` never reads the
/// book: between pokes it extends the head's last recorded value.
///
/// No owner and no parameters: the oracle only reads the factory, the markets and their books.
contract ImpliedProbabilityOracle is IImpliedProbabilityOracle {
    using SafeCastLib for uint256;

    uint256 internal constant ONE = 1e6;
    /// @inheritdoc IImpliedProbabilityOracle
    uint256 public constant CAPACITY = 256;
    /// @inheritdoc IImpliedProbabilityOracle
    uint256 public constant MIN_SPACING = 30;

    /// @inheritdoc IImpliedProbabilityOracle
    address public immutable factory;

    struct Ring {
        uint64 lastBlock; // block of the latest poke
        uint16 next; // index the next checkpoint is written to
        uint16 count; // checkpoints stored, at most CAPACITY
    }

    mapping(address market => Observation) internal _head;
    mapping(address market => Ring) internal _rings;
    mapping(address market => Observation[CAPACITY]) internal _checkpoints;

    constructor(IHunchBookFactory factory_) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        factory = address(factory_);
    }

    // ------------------------------------------------------------------------------------------
    // Spot
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IImpliedProbabilityOracle
    function chanceE6(address market) external view returns (uint256 chance, bool stale) {
        _requireMarket(market);
        Quote memory q = _quote(market);
        return (q.chanceE6, q.stale);
    }

    /// @inheritdoc IImpliedProbabilityOracle
    function quote(address market) external view returns (Quote memory) {
        _requireMarket(market);
        return _quote(market);
    }

    // ------------------------------------------------------------------------------------------
    // Recording
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IImpliedProbabilityOracle
    function poke(address market) external returns (bool written) {
        _requireMarket(market);
        return _poke(market);
    }

    /// @inheritdoc IImpliedProbabilityOracle
    function pokeMany(address[] calldata markets) external returns (uint256 written) {
        for (uint256 i; i < markets.length; ++i) {
            _requireMarket(markets[i]);
            if (_poke(markets[i])) ++written;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Averages
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IImpliedProbabilityOracle
    function consult(address market, uint256 secondsAgo) external view returns (uint256 chanceTwapE6) {
        (chanceTwapE6,,) = consultFull(market, secondsAgo);
    }

    /// @inheritdoc IImpliedProbabilityOracle
    function consultFull(address market, uint256 secondsAgo)
        public
        view
        returns (uint256 chanceTwapE6, uint256 spreadTwapE6, uint256 updatedAt)
    {
        if (secondsAgo == 0) revert ZeroPeriod();
        Observation memory h = _head[market];
        if (h.timestamp == 0) revert NoObservations();
        uint256 nowTs = block.timestamp;
        if (secondsAgo > nowTs) revert InsufficientHistory(_oldest(market).timestamp);

        (uint256 cNow, uint256 sNow) = _extend(h, nowTs);
        (uint256 cThen, uint256 sThen) = _cumulativeAt(market, h, nowTs - secondsAgo);
        chanceTwapE6 = (cNow - cThen) / secondsAgo;
        spreadTwapE6 = (sNow - sThen) / secondsAgo;
        updatedAt = h.timestamp;
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IImpliedProbabilityOracle
    function latest(address market) external view returns (Observation memory) {
        return _head[market];
    }

    /// @inheritdoc IImpliedProbabilityOracle
    function checkpointCount(address market) external view returns (uint256) {
        return _rings[market].count;
    }

    /// @inheritdoc IImpliedProbabilityOracle
    function checkpointAt(address market, uint256 index) external view returns (Observation memory) {
        Ring memory r = _rings[market];
        if (index >= r.count) revert NoObservations();
        return _checkpointAt(market, r, index);
    }

    /// @inheritdoc IImpliedProbabilityOracle
    function maxWindow() external pure returns (uint256) {
        return (CAPACITY - 1) * MIN_SPACING;
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    function _requireMarket(address market) internal view {
        if (!IHunchBookFactory(factory).isMarket(market)) revert UnknownMarket();
    }

    function _quote(address market) internal view returns (Quote memory q) {
        IMarket m = IMarket(market);
        Phase p = m.phase();
        q.phase = p;
        if (p == Phase.Settled) {
            q.chanceE6 = m.outcome() == Outcome.Yes ? ONE : 0;
        } else if (p == Phase.Voided) {
            q.chanceE6 = ONE / 2;
        } else if (p == Phase.Pool || p == Phase.PoolLocked) {
            q.chanceE6 = _poolChance(m);
            q.spreadE6 = ONE;
        } else {
            // Graduated or Closed: the book.
            BookPrice.Quote memory b = BookPrice.yesQuote(m.book());
            (q.hasBid, q.hasAsk, q.bidE6, q.askE6) = (b.hasBid, b.hasAsk, b.bid, b.ask);
            uint256 bid = BookPrice.capped(b.bid);
            uint256 ask = BookPrice.capped(b.ask);
            q.spreadE6 = ONE;
            if (b.hasBid && b.hasAsk) {
                q.chanceE6 = (bid + ask) / 2;
                q.spreadE6 = ask > bid ? ask - bid : 0;
            } else if (b.hasBid) {
                q.chanceE6 = bid;
            } else if (b.hasAsk) {
                q.chanceE6 = ask;
            } else {
                q.stale = true;
                Observation memory h = _head[market];
                q.chanceE6 = h.timestamp != 0 ? h.chanceE6 : _poolChance(m);
            }
        }
    }

    /// Y / T, or 50% for an empty pool. After graduation the totals are frozen: the opening price.
    function _poolChance(IMarket m) internal view returns (uint256) {
        (uint256 y, uint256 n,) = m.poolTotals();
        uint256 t = y + n;
        return t == 0 ? ONE / 2 : y * ONE / t;
    }

    function _poke(address market) internal returns (bool) {
        Ring memory r = _rings[market];
        if (r.lastBlock == block.number) return false;
        r.lastBlock = block.number.toUint64();

        Quote memory q = _quote(market);
        Observation memory h = _head[market];
        uint256 nowTs = block.timestamp;
        (uint256 c, uint256 s) = h.timestamp == 0 ? (0, 0) : _extend(h, nowTs);
        h = Observation({
            timestamp: nowTs.toUint40(),
            chanceE6: q.chanceE6.toUint24(),
            spreadE6: q.spreadE6.toUint24(),
            chanceCumulative: c.toUint88(),
            spreadCumulative: s.toUint80()
        });
        _head[market] = h;

        bool checkpoint = r.count == 0
            || nowTs >= uint256(_checkpoints[market][(r.next + CAPACITY - 1) % CAPACITY].timestamp) + MIN_SPACING;
        if (checkpoint) {
            _checkpoints[market][r.next] = h;
            // CAPACITY fits in uint16, so both stay in range.
            // forge-lint: disable-next-line(unsafe-typecast)
            r.next = uint16((r.next + 1) % CAPACITY);
            if (r.count < CAPACITY) ++r.count;
        }
        _rings[market] = r;
        emit Poked(market, q.chanceE6, q.spreadE6, q.stale, checkpoint);
        return true;
    }

    /// The accumulators at `t` >= h.timestamp, extending the head's recorded values.
    function _extend(Observation memory h, uint256 t) internal pure returns (uint256 c, uint256 s) {
        uint256 dt = t - h.timestamp;
        c = uint256(h.chanceCumulative) + uint256(h.chanceE6) * dt;
        s = uint256(h.spreadCumulative) + uint256(h.spreadE6) * dt;
    }

    /// The accumulators at `target`: exact at or after the head and at a checkpoint, linear between
    /// two checkpoints (or between the newest checkpoint and the head).
    function _cumulativeAt(address market, Observation memory h, uint256 target)
        internal
        view
        returns (uint256 c, uint256 s)
    {
        if (target >= h.timestamp) return _extend(h, target);

        Ring memory r = _rings[market];
        Observation memory oldest = _checkpointAt(market, r, 0);
        if (target < oldest.timestamp) revert InsufficientHistory(oldest.timestamp);

        // Largest index whose timestamp <= target. Checkpoints are strictly increasing in time.
        uint256 lo = 0;
        uint256 hi = r.count - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (_checkpointAt(market, r, mid).timestamp <= target) lo = mid;
            else hi = mid - 1;
        }
        Observation memory a = _checkpointAt(market, r, lo);
        if (a.timestamp == target) return (a.chanceCumulative, a.spreadCumulative);
        // target < h.timestamp, so if `a` is the newest checkpoint the head comes after it.
        Observation memory b = lo + 1 < r.count ? _checkpointAt(market, r, lo + 1) : h;

        uint256 span = uint256(b.timestamp) - a.timestamp;
        uint256 into = target - a.timestamp;
        c = uint256(a.chanceCumulative) + (uint256(b.chanceCumulative) - a.chanceCumulative) * into / span;
        s = uint256(a.spreadCumulative) + (uint256(b.spreadCumulative) - a.spreadCumulative) * into / span;
    }

    /// Checkpoint `index` counted from the oldest stored one.
    function _checkpointAt(address market, Ring memory r, uint256 index) internal view returns (Observation memory) {
        return _checkpoints[market][(uint256(r.next) + CAPACITY - r.count + index) % CAPACITY];
    }

    function _oldest(address market) internal view returns (Observation memory) {
        Ring memory r = _rings[market];
        return _checkpointAt(market, r, 0);
    }
}
