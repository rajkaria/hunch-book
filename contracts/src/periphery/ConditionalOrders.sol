// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IHunchRouter} from "../interfaces/IHunchRouter.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IConditionalOrders} from "./interfaces/IConditionalOrders.sol";
import {BookPrice} from "./libraries/BookPrice.sol";

/// @title ConditionalOrders
/// @notice Take-profit, stop-loss and limit orders on outcome tokens (roadmap A-11). See
/// IConditionalOrders and docs/PERIPHERY.md.
///
/// Holds nothing between transactions. `execute` measures every token by balance change around the
/// trade, pays the output (minus the tip) to the owner and the tip to the executor, and returns
/// every other token that came back (unspent input, extra YES from a NO sale) to the owner. The router
/// approval is set to the exact amount pulled and reset to zero in the same call.
///
/// The router's own limit is tightened so the owner's limit holds after the tip:
/// grossMin = ceil(limit * 10000 / (10000 - tipBps)), and the owner's net is checked again afterwards.
contract ConditionalOrders is IConditionalOrders {
    using SafeTransferLib for address;

    /// @inheritdoc IConditionalOrders
    uint256 public constant MAX_TIP_BPS = 50;
    uint256 internal constant BPS = 10_000;

    /// @inheritdoc IConditionalOrders
    address public immutable factory;
    /// @inheritdoc IConditionalOrders
    address public immutable router;
    /// @inheritdoc IConditionalOrders
    address public immutable usdc;
    /// @inheritdoc IConditionalOrders
    uint8 public immutable kuruVersion;

    /// @inheritdoc IConditionalOrders
    uint256 public orderCount;
    mapping(uint256 orderId => Order) internal _orders;

    bool private transient _locked;

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// Token movements of one execution.
    struct Fill {
        address tokenIn;
        address tokenOut;
        uint256 pulled;
        uint256 spent;
        uint256 out;
        uint256 tip;
        uint256 received;
    }

    /// @param factory_ The Hunch Book factory whose markets orders can trade.
    /// @param router_ The HunchRouter for that factory.
    /// @param kuruVersion_ The Kuru version of the stack's books (1 or 2), which sets how prices are read.
    constructor(IHunchBookFactory factory_, address router_, uint8 kuruVersion_) {
        if (address(factory_) == address(0) || router_ == address(0)) revert ZeroAddress();
        if (kuruVersion_ != 1 && kuruVersion_ != 2) revert BadKuruVersion();
        address usdc_ = factory_.usdc();
        if (usdc_ == address(0)) revert ZeroAddress();
        factory = address(factory_);
        router = router_;
        usdc = usdc_;
        kuruVersion = kuruVersion_;
    }

    // ------------------------------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IConditionalOrders
    function place(OrderRequest calldata req) external nonReentrant returns (uint256 orderId) {
        if (!IHunchBookFactory(factory).isMarket(req.market)) revert UnknownMarket();
        if (req.amountIn == 0) revert ZeroAmount();
        if (req.executorTipBps > MAX_TIP_BPS) revert TipTooHigh();
        if (req.triggerPriceE6 > BookPrice.ONE) revert BadTrigger();
        if (req.expiry < block.timestamp) revert BadExpiry();

        orderId = ++orderCount;
        _orders[orderId] = Order({
            owner: msg.sender,
            expiry: req.expiry,
            triggerPriceE6: req.triggerPriceE6,
            market: req.market,
            kind: req.kind,
            condition: req.condition,
            status: Status.Open,
            executorTipBps: req.executorTipBps,
            amountIn: req.amountIn,
            limit: req.limit
        });
        emit OrderPlaced(
            orderId,
            msg.sender,
            req.market,
            req.kind,
            req.condition,
            req.triggerPriceE6,
            req.expiry,
            req.executorTipBps,
            req.amountIn,
            req.limit
        );
    }

    /// @inheritdoc IConditionalOrders
    function cancel(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status == Status.None) revert UnknownOrder(orderId);
        if (o.owner != msg.sender) revert NotOwner();
        if (o.status != Status.Open) revert OrderNotOpen(orderId);
        o.status = Status.Cancelled;
        emit OrderCancelled(orderId, msg.sender);
    }

    // ------------------------------------------------------------------------------------------
    // Anyone
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IConditionalOrders
    function execute(uint256 orderId) external nonReentrant returns (uint256 received) {
        Order memory o = _orders[orderId];
        if (o.status == Status.None) revert UnknownOrder(orderId);
        if (o.status != Status.Open) revert OrderNotOpen(orderId);
        if (block.timestamp > o.expiry) revert OrderExpired(orderId);
        (bool available, uint256 price) = _price(o.market, o.kind);
        if (!available || !_met(o.condition, price, o.triggerPriceE6)) revert NotTriggered(orderId, available, price);

        _orders[orderId].status = Status.Executed;
        Fill memory f = _fill(o);
        received = f.received;
        emit OrderExecuted(orderId, o.owner, msg.sender, price, f.spent, received, f.tip);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IConditionalOrders
    function currentPrice(address market, IHunchRouter.Kind kind)
        external
        view
        returns (bool available, uint256 priceE6)
    {
        if (!IHunchBookFactory(factory).isMarket(market)) revert UnknownMarket();
        return _price(market, kind);
    }

    /// @inheritdoc IConditionalOrders
    function isTriggered(uint256 orderId) external view returns (bool) {
        Order memory o = _orders[orderId];
        if (o.status != Status.Open || block.timestamp > o.expiry) return false;
        (bool available, uint256 price) = _price(o.market, o.kind);
        return available && _met(o.condition, price, o.triggerPriceE6);
    }

    /// @inheritdoc IConditionalOrders
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    /// Pulls the input, trades, and pays out. Every amount is a balance change of this contract.
    function _fill(Order memory o) internal returns (Fill memory f) {
        (address yes, address no) = IMarket(o.market).tokens();
        address u = usdc;
        uint256[3] memory before =
            [u.balanceOf(address(this)), yes.balanceOf(address(this)), no.balanceOf(address(this))];

        uint256 tipBps = o.executorTipBps;
        uint256 grossMin = _grossMin(o.limit, tipBps);
        IHunchRouter.Kind kind = o.kind;
        if (kind == IHunchRouter.Kind.BuyYes) {
            (f.tokenIn, f.tokenOut, f.pulled) = (u, yes, o.amountIn);
        } else if (kind == IHunchRouter.Kind.SellYes) {
            (f.tokenIn, f.tokenOut, f.pulled) = (yes, u, o.amountIn);
        } else if (kind == IHunchRouter.Kind.BuyNo) {
            (f.tokenIn, f.tokenOut, f.pulled) = (u, no, o.limit);
        } else {
            (f.tokenIn, f.tokenOut, f.pulled) = (no, u, o.amountIn);
        }

        // The owner approved this contract for orders; `o.owner` is the only address it pulls from.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        if (f.pulled != 0) f.tokenIn.safeTransferFrom(o.owner, address(this), f.pulled);
        f.tokenIn.safeApprove(router, f.pulled);
        // Return values are ignored on purpose: amounts are measured as balance changes below.
        if (kind == IHunchRouter.Kind.BuyYes) {
            // forge-lint: disable-next-line(unused-return)
            IHunchRouter(router).buyYes(o.market, o.amountIn, grossMin, block.timestamp);
        } else if (kind == IHunchRouter.Kind.SellYes) {
            // forge-lint: disable-next-line(unused-return)
            IHunchRouter(router).sellYes(o.market, o.amountIn, grossMin, block.timestamp);
        } else if (kind == IHunchRouter.Kind.BuyNo) {
            // forge-lint: disable-next-line(unused-return)
            IHunchRouter(router).buyNo(o.market, o.amountIn, o.limit, block.timestamp);
        } else {
            // forge-lint: disable-next-line(unused-return)
            IHunchRouter(router).sellNo(o.market, o.amountIn, grossMin, block.timestamp);
        }
        f.tokenIn.safeApprove(router, 0);

        address[3] memory tokens = [u, yes, no];
        uint256[3] memory delta;
        for (uint256 i; i < 3; ++i) {
            delta[i] = tokens[i].balanceOf(address(this)) - before[i];
            if (tokens[i] == f.tokenOut) f.out = delta[i];
            // A NO purchase against bids above 1 USDC returns more USDC than was pulled: nothing spent.
            if (tokens[i] == f.tokenIn) f.spent = f.pulled > delta[i] ? f.pulled - delta[i] : 0;
        }

        f.tip = f.out * tipBps / BPS;
        f.received = f.out - f.tip;
        if (kind == IHunchRouter.Kind.BuyNo) {
            // The router delivers exactly amountIn NO; it cannot take more than the `limit` pulled.
            if (f.out != o.amountIn) revert Slippage();
        } else if (f.received < o.limit) {
            revert Slippage();
        }

        f.tokenOut.safeTransfer(o.owner, f.received);
        if (f.tip != 0) f.tokenOut.safeTransfer(msg.sender, f.tip);
        // Unspent input, and any other token the trade returned (extra YES from selling NO).
        for (uint256 i; i < 3; ++i) {
            if (tokens[i] != f.tokenOut && delta[i] != 0) tokens[i].safeTransfer(o.owner, delta[i]);
        }
    }

    /// The trigger-side price for `kind`, from the market's book (see BookPrice for NO prices).
    function _price(address market, IHunchRouter.Kind kind) internal view returns (bool available, uint256 priceE6) {
        BookPrice.Quote memory q = BookPrice.yesQuote(IMarket(market).book(), kuruVersion);
        if (kind == IHunchRouter.Kind.BuyYes) return (q.hasAsk, q.ask);
        if (kind == IHunchRouter.Kind.SellYes) return (q.hasBid, q.bid);
        if (kind == IHunchRouter.Kind.BuyNo) return (q.hasBid, BookPrice.complement(q.bid));
        return (q.hasAsk, BookPrice.complement(q.ask));
    }

    function _met(Condition c, uint256 price, uint256 trigger) internal pure returns (bool) {
        return c == Condition.AtOrAbove ? price >= trigger : price <= trigger;
    }

    /// The router minimum that leaves at least `limit` after a `tipBps` tip rounded down:
    /// out >= ceil(limit * B / (B - t)) implies out - floor(out * t / B) >= limit.
    function _grossMin(uint256 limit, uint256 tipBps) internal pure returns (uint256) {
        if (limit == 0) return 0;
        return (limit * BPS - 1) / (BPS - tipBps) + 1;
    }
}
