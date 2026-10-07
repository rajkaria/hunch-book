// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {KuruSwapResult} from "../../src/interfaces/external/IKuruV2.sol";

/// Test stand-ins for Kuru's v2 exchange, written from the deployed contracts' behaviour as observed on
/// Monad testnet (2026-10-07), not from Kuru's code:
/// - AccountCore keeps balances per uint40 account id; anyone can deposit to any root account, only the
///   owner withdraws; a book moves balances between accounts when it matches.
/// - SpotRouter deploys books with CREATE2 (address = computeAddress of the same parameters) and
///   registers them in AccountCore.
/// - A book matches exact-in market orders against resting levels. Buy (quote in): at price p a level
///   gives floor(q * sP / p) base for ceil(base * p / sP) quote. Sell (base in): each base unit pays
///   floor(base * p / sP) quote. The taker fee is taken from the output, rounded up:
///   out = gross - ceil(gross * fee / 1e7). Matching stops when the rest cannot fill a whole unit, so
///   dust is left unused, as on the real books.

contract MockKuruWithdrawalLimiterV2 {
    error WithdrawalLimitExceeded();

    mapping(address token => address) public priceSource;
    bool public exhausted;

    function setPriceSource(address token, address source) external {
        priceSource[token] = source;
    }

    function setExhausted(bool v) external {
        exhausted = v;
    }

    function check() external view {
        if (exhausted) revert WithdrawalLimitExceeded();
    }
}

contract MockKuruAccountCoreV2 {
    error NotOwner();
    error NotBook();
    error InsufficientBalance();
    error WithdrawalsFrozen();
    error TokenNotEnabled();
    error ProtocolPaused();

    uint40 public lastId;
    mapping(address => uint40) public rootAccountIdOf;
    mapping(uint40 => address) public ownerOf;
    mapping(uint40 => mapping(address token => uint256)) internal _balances;
    mapping(address book => bool) public verifiedSpotOrderBook;
    mapping(address book => address) public spotOrderBookToBaseToken;
    mapping(address book => address) public spotOrderBookToQuoteToken;
    mapping(address token => bool) public enabled;
    mapping(uint40 => uint32) public takerFeeOverride;
    address public withdrawalLimiter;
    address public spotRouter;
    bool public withdrawalsFrozen;
    bool public protocolPaused;
    uint40 public feeAccount;

    constructor() {
        feeAccount = _create(address(0xFEE));
    }

    function setSpotRouter(address r) external {
        spotRouter = r;
    }

    function setWithdrawalLimiter(address l) external {
        withdrawalLimiter = l;
    }

    function setWithdrawalsFrozen(bool v) external {
        withdrawalsFrozen = v;
    }

    function setProtocolPaused(bool v) external {
        protocolPaused = v;
    }

    function configureSpotToken(address token, bool on) external {
        enabled[token] = on;
    }

    function spotTokenConfigs(address token) external view returns (uint8, bool) {
        return (6, enabled[token]);
    }

    function setTakerFeeOverride(uint40 id, uint32 pps) external {
        takerFeeOverride[id] = pps;
    }

    function effectiveSpotTakerFeePps(uint40 id, uint256 marketFee) external view returns (uint32) {
        uint32 o = takerFeeOverride[id];
        // forge-lint: disable-next-line(unsafe-typecast)
        return o != 0 ? o : uint32(marketFee);
    }

    /// Test helper: registers a book directly (the router does this for books it deploys).
    function registerSpotMarket(address book, address base, address quote) external {
        verifiedSpotOrderBook[book] = true;
        spotOrderBookToBaseToken[book] = base;
        spotOrderBookToQuoteToken[book] = quote;
    }

    /// Test helper (on Kuru only books may call it): the user's account, created if needed.
    function ensureRootAccount(address user) external returns (uint40) {
        uint40 id = rootAccountIdOf[user];
        return id != 0 ? id : _create(user);
    }

    /// Deposit by owner: creates the owner's root account on first use, as Kuru does.
    function deposit(address rootOwner, address token, uint256 amount) external payable {
        uint40 id = rootAccountIdOf[rootOwner];
        if (id == 0) id = _create(rootOwner);
        _deposit(id, token, amount);
    }

    function deposit(uint40 id, address token, uint256 amount) external payable {
        _deposit(id, token, amount);
    }

    function _deposit(uint40 id, address token, uint256 amount) internal {
        if (protocolPaused) revert ProtocolPaused();
        if (!enabled[token]) revert TokenNotEnabled();
        if (ownerOf[id] == address(0)) revert NotOwner();
        _balances[id][token] += amount;
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "transferFrom");
    }

    function withdraw(uint40 id, address token, uint256 amount, address recipient) external {
        if (ownerOf[id] != msg.sender) revert NotOwner();
        if (withdrawalsFrozen) revert WithdrawalsFrozen();
        if (withdrawalLimiter != address(0)) MockKuruWithdrawalLimiterV2(withdrawalLimiter).check();
        if (_balances[id][token] < amount) revert InsufficientBalance();
        _balances[id][token] -= amount;
        require(IERC20(token).transfer(recipient, amount), "transfer");
    }

    function getBalance(uint40 id, address token) external view returns (uint256) {
        return _balances[id][token];
    }

    /// Books move balances when they match.
    function move(uint40 from, uint40 to, address token, uint256 amount) external {
        if (!verifiedSpotOrderBook[msg.sender]) revert NotBook();
        if (_balances[from][token] < amount) revert InsufficientBalance();
        _balances[from][token] -= amount;
        _balances[to][token] += amount;
    }

    function _create(address user) internal returns (uint40 id) {
        id = ++lastId;
        rootAccountIdOf[user] = id;
        ownerOf[id] = user;
    }
}

contract MockKuruSpotOrderBookV2 {
    error NotAccountOwner();
    error SlippageExceeded();
    error DeadlinePassed();
    error MarketPaused();

    uint256 internal constant PPS = 1e7;

    struct Level {
        uint32 price;
        uint96 size;
    }

    MockKuruAccountCoreV2 public immutable core;
    address public immutable baseToken;
    address public immutable quoteToken;
    uint96 public immutable sizePrecision;
    uint32 public immutable pricePrecision;
    uint32 public immutable tickSize;
    uint32 public immutable passiveSpreadTicks;
    uint96 public immutable minQuoteNotional;
    uint96 public immutable maxQuoteNotional;
    uint256 public takerFeePps;
    uint256 public makerFeePps;
    uint8 public marketState;
    /// The account resting liquidity belongs to.
    uint40 public makerId;
    /// What `bestBidAsk` returns for an empty ask side (0 or type(uint32).max: both occur in tests).
    uint32 public emptyAsk = type(uint32).max;

    /// When set, `swap` calls `reenterTarget` with `reenterData` first (re-entrancy tests).
    address public reenterTarget;
    bytes public reenterData;

    Level[] internal _asks; // ascending price
    Level[] internal _bids; // descending price

    constructor(
        MockKuruAccountCoreV2 core_,
        address base,
        address quote,
        uint96 sizePrecision_,
        uint32 pricePrecision_,
        uint32 tickSize_,
        uint32 passiveSpreadTicks_,
        uint96 minQuoteNotional_,
        uint96 maxQuoteNotional_,
        uint256 takerFeePps_,
        uint256 makerFeePps_
    ) {
        core = core_;
        baseToken = base;
        quoteToken = quote;
        sizePrecision = sizePrecision_;
        pricePrecision = pricePrecision_;
        tickSize = tickSize_;
        passiveSpreadTicks = passiveSpreadTicks_;
        minQuoteNotional = minQuoteNotional_;
        maxQuoteNotional = maxQuoteNotional_;
        takerFeePps = takerFeePps_;
        makerFeePps = makerFeePps_;
    }

    function accountCore() external view returns (address) {
        return address(core);
    }

    // ---- test controls ----

    function setMaker(uint40 id) external {
        makerId = id;
    }

    function setFees(uint256 taker, uint256 maker) external {
        takerFeePps = taker;
        makerFeePps = maker;
    }

    function setMarketState(uint8 s) external {
        marketState = s;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function setEmptyAsk(uint32 v) external {
        emptyAsk = v;
    }

    /// Adds an ask level (prices must be added in increasing order). The maker account must hold the base.
    function addAsk(uint32 price, uint96 size) external {
        _asks.push(Level(price, size));
    }

    /// Adds a bid level (prices must be added in decreasing order). The maker account must hold the quote.
    function addBid(uint32 price, uint96 size) external {
        _bids.push(Level(price, size));
    }

    function clear() external {
        delete _asks;
        delete _bids;
    }

    // ---- Kuru v2 surface ----

    function bestBidAsk() external view returns (uint32 bid, uint32 ask) {
        (uint256 i, uint256 j) = (_firstLive(_bids), _firstLive(_asks));
        bid = i < _bids.length ? _bids[i].price : 0;
        ask = j < _asks.length ? _asks[j].price : emptyAsk;
    }

    function getL2Book(uint256 levels)
        external
        view
        returns (
            uint32[] memory bidPrices,
            uint96[] memory bidSizes,
            uint32[] memory askPrices,
            uint96[] memory askSizes
        )
    {
        (bidPrices, bidSizes) = _side(_bids, levels);
        (askPrices, askSizes) = _side(_asks, levels);
    }

    function estimateSwap(uint40 userId, bool isBuy, uint128 amountIn) external view returns (KuruSwapResult memory r) {
        (r,) = _match(userId, isBuy, amountIn);
    }

    /// At the book's own fees (no account).
    function estimateSwap(bool isBuy, uint128 amountIn) external view returns (KuruSwapResult memory r) {
        (r,) = _match(0, isBuy, amountIn);
    }

    function swap(uint40 userId, bool isBuy, uint128 amountIn, uint128 minAmountOut, uint64 deadline)
        external
        returns (KuruSwapResult memory r)
    {
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (core.ownerOf(userId) != msg.sender) revert NotAccountOwner();
        if (marketState != 0) revert MarketPaused();
        if (block.timestamp > deadline) revert DeadlinePassed();
        uint256 fee;
        (r, fee) = _match(userId, isBuy, amountIn);
        if (r.amountOut < minAmountOut) revert SlippageExceeded();
        _consume(isBuy, amountIn);
        (address tin, address tout) = isBuy ? (quoteToken, baseToken) : (baseToken, quoteToken);
        // Taker pays what it used to the maker; the maker pays the gross output; the fee goes to Kuru.
        core.move(userId, makerId, tin, r.amountInUsed);
        core.move(makerId, userId, tout, r.amountOut);
        if (fee != 0) core.move(makerId, core.feeAccount(), tout, fee);
    }

    // ---- matching ----

    function _match(uint40 userId, bool isBuy, uint256 amountIn)
        internal
        view
        returns (KuruSwapResult memory r, uint256 fee)
    {
        Level[] storage levels = isBuy ? _asks : _bids;
        uint256 left = amountIn;
        uint256 gross;
        for (uint256 i; i < levels.length && left != 0; ++i) {
            (uint256 used, uint256 got, bool stop) = _fill(isBuy, levels[i], left);
            if (stop) break;
            left -= used;
            gross += got;
        }
        uint256 f = core.effectiveSpotTakerFeePps(userId, takerFeePps);
        fee = (gross * f + PPS - 1) / PPS;
        // forge-lint: disable-next-line(unsafe-typecast)
        r = KuruSwapResult(uint128(amountIn - left), uint128(gross - fee));
    }

    function _consume(bool isBuy, uint256 amountIn) internal {
        Level[] storage levels = isBuy ? _asks : _bids;
        uint256 left = amountIn;
        for (uint256 i; i < levels.length && left != 0; ++i) {
            Level storage l = levels[i];
            (uint256 used, uint256 got, bool stop) = _fill(isBuy, l, left);
            if (stop) break;
            left -= used;
            uint256 take = isBuy ? got : used;
            // forge-lint: disable-next-line(unsafe-typecast)
            l.size -= uint96(take);
        }
    }

    /// One level against `left` input: input used, gross output, and whether matching stops here (the
    /// rest cannot fill a whole unit). Empty levels use nothing.
    function _fill(bool isBuy, Level storage l, uint256 left)
        internal
        view
        returns (uint256 used, uint256 got, bool stop)
    {
        if (l.size == 0) return (0, 0, false);
        uint256 p = l.price;
        uint256 sP = sizePrecision;
        if (isBuy) {
            uint256 fillable = left * sP / p;
            if (fillable == 0) return (0, 0, true);
            got = fillable < l.size ? fillable : l.size;
            used = (got * p + sP - 1) / sP;
        } else {
            used = left < l.size ? left : l.size;
            got = used * p / sP;
            if (got == 0) return (0, 0, true);
        }
    }

    function _firstLive(Level[] storage levels) internal view returns (uint256 i) {
        while (i < levels.length && levels[i].size == 0) {
            ++i;
        }
    }

    function _side(Level[] storage levels, uint256 max)
        internal
        view
        returns (uint32[] memory prices, uint96[] memory sizes)
    {
        uint256 n;
        for (uint256 i; i < levels.length; ++i) {
            if (levels[i].size != 0) ++n;
        }
        if (n > max) n = max;
        prices = new uint32[](n);
        sizes = new uint96[](n);
        uint256 k;
        for (uint256 i; i < levels.length && k < n; ++i) {
            if (levels[i].size == 0) continue;
            prices[k] = levels[i].price;
            sizes[k] = levels[i].size;
            ++k;
        }
    }
}

contract MockKuruSpotRouterV2 {
    MockKuruAccountCoreV2 public immutable core;
    mapping(address => bool) public verifiedSpotMarket;
    mapping(address => bool) public whitelistedSpotTokens;

    constructor(MockKuruAccountCoreV2 core_) {
        core = core_;
    }

    function whitelistSpotToken(address token, bool status) external {
        whitelistedSpotTokens[token] = status;
    }

    /// Test helper: marks an address as a book this router deployed.
    function setVerified(address book, bool v) external {
        verifiedSpotMarket[book] = v;
    }

    function deploySpotMarket(
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint32 passiveSpreadTicks,
        uint96 minQuoteNotional,
        uint96 maxQuoteNotional,
        uint256 takerFeePps,
        uint256 makerFeePps
    ) external returns (address proxy) {
        proxy = address(
            new MockKuruSpotOrderBookV2{
                salt: _salt(
                    base,
                    quote,
                    sizePrecision,
                    pricePrecision,
                    tickSize,
                    passiveSpreadTicks,
                    minQuoteNotional,
                    maxQuoteNotional,
                    takerFeePps,
                    makerFeePps
                )
            }(
                core,
                base,
                quote,
                sizePrecision,
                pricePrecision,
                tickSize,
                passiveSpreadTicks,
                minQuoteNotional,
                maxQuoteNotional,
                takerFeePps,
                makerFeePps
            )
        );
        verifiedSpotMarket[proxy] = true;
        core.registerSpotMarket(proxy, base, quote);
    }

    function computeAddress(
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint32 passiveSpreadTicks,
        uint96 minQuoteNotional,
        uint96 maxQuoteNotional,
        uint256 takerFeePps,
        uint256 makerFeePps
    ) external view returns (address) {
        bytes memory init = abi.encodePacked(
            type(MockKuruSpotOrderBookV2).creationCode,
            abi.encode(
                core,
                base,
                quote,
                sizePrecision,
                pricePrecision,
                tickSize,
                passiveSpreadTicks,
                minQuoteNotional,
                maxQuoteNotional,
                takerFeePps,
                makerFeePps
            )
        );
        bytes32 salt = _salt(
            base,
            quote,
            sizePrecision,
            pricePrecision,
            tickSize,
            passiveSpreadTicks,
            minQuoteNotional,
            maxQuoteNotional,
            takerFeePps,
            makerFeePps
        );
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(init)));
        return address(uint160(uint256(h)));
    }

    function _salt(
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint32 passiveSpreadTicks,
        uint96 minQuoteNotional,
        uint96 maxQuoteNotional,
        uint256 takerFeePps,
        uint256 makerFeePps
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                base,
                quote,
                sizePrecision,
                pricePrecision,
                tickSize,
                passiveSpreadTicks,
                minQuoteNotional,
                maxQuoteNotional,
                takerFeePps,
                makerFeePps
            )
        );
    }
}
