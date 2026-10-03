// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ICollateralVault} from "../interfaces/ICollateralVault.sol";
import {IGraduator} from "../interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Outcome, Phase, Side, Window} from "../interfaces/IHunchBookTypes.sol";

/// Circle USDC's EIP-3009 receive path (v, r, s variant, available since FiatToken v2).
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title Market
/// @notice One yes/no question. A minimal clone created by HunchBookFactory.
///
/// Lifecycle (docs/PROTOCOL.md §4): POOL → (graduate) GRADUATED → CLOSED → SETTLED, or
/// POOL → POOL_LOCKED → SETTLED; any non-final phase → VOIDED after the settlement deadline.
/// The market holds no USDC (the vault does). It holds YES/NO tokens only between graduation
/// and each staker's claim. No address can set its outcome: only its resolver's reading of the
/// source can, through `settle` or `proveYes`.
contract Market is IMarket {
    using SafeCastLib for uint256;
    using SafeTransferLib for address;

    /// φ: 2% of winnings, in basis points.
    uint256 public constant FEE_BPS = 200;
    uint256 internal constant BPS = 10_000;

    struct InitParams {
        address vault;
        address usdc;
        uint256 marketId;
        uint32 templateId;
        IResolver resolver;
        bytes params;
        Window window;
        GraduationRule rule;
        MarketCaps caps;
        address creator;
        address yes;
        address no;
        Side firstSide;
        uint256 firstStake;
    }

    enum Stage {
        Pool,
        Graduated,
        Settled,
        Voided
    }

    struct Position {
        uint128 yes;
        uint128 no;
        bool tokensClaimed;
        bool poolClaimed;
    }

    error AlreadyInitialized();
    error ZeroAddress();

    // ---- set once at initialization ----
    address public factory;
    address public vault;
    address internal _usdc;
    uint256 public marketId;
    uint32 public templateId;
    IResolver public resolver;
    address public creator;
    address internal _yes;
    address internal _no;
    bytes internal _params;
    Window internal _window;
    GraduationRule internal _rule;
    MarketCaps internal _caps;

    // ---- state ----
    Stage internal _stage;
    bool public graduated;
    Outcome public outcome;
    bytes32 public evidenceHash;
    address public book;

    uint128 internal _yesTotal;
    uint128 internal _noTotal;
    uint32 internal _stakers;
    uint32 internal _yesStakers;
    uint32 internal _noStakers;
    uint32 internal _yesTokenClaims;
    uint32 internal _noTokenClaims;
    uint32 internal _winnerClaims;

    mapping(address user => Position) internal _positions;

    uint256 private _lock;

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    error Reentrancy();

    /// The implementation can never be initialized; clones start with `factory == 0`.
    constructor() {
        factory = address(0xdead);
    }

    /// Called once by the factory in the same transaction that creates the clone.
    /// Makes the creator's first stake, pulled from the creator by the vault.
    function initialize(InitParams calldata p) external {
        if (factory != address(0)) revert AlreadyInitialized();
        if (p.vault == address(0) || p.usdc == address(0) || p.creator == address(0)) revert ZeroAddress();
        factory = msg.sender;
        vault = p.vault;
        _usdc = p.usdc;
        marketId = p.marketId;
        templateId = p.templateId;
        resolver = p.resolver;
        _params = p.params;
        _window = p.window;
        _rule = p.rule;
        _caps = p.caps;
        creator = p.creator;
        _yes = p.yes;
        _no = p.no;
        _lock = 1;

        if (p.firstStake < p.caps.creatorMinStake) revert StakeTooSmall();
        _stake(p.creator, p.creator, p.firstSide, p.firstStake);
    }

    // ------------------------------------------------------------------------------------------
    // Staking
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarket
    function stake(Side side, uint256 amount) external nonReentrant {
        _stake(msg.sender, msg.sender, side, amount);
    }

    /// @inheritdoc IMarket
    function stakeFor(address user, Side side, uint256 amount) external nonReentrant {
        _stake(msg.sender, user, side, amount);
    }

    /// @inheritdoc IMarket
    function stakeWithAuthorization(
        address user,
        Side side,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature
    ) external nonReentrant {
        _checkStake(user, amount);
        _record(user, side, amount);
        _receiveAuthorized(user, amount, validAfter, validBefore, authorizationNonce(user, side, salt), signature);
        _usdc.safeTransfer(vault, amount);
        ICollateralVault(vault).creditPool(amount);
    }

    // ------------------------------------------------------------------------------------------
    // Graduation and token claims
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarket
    function graduate() external nonReentrant {
        Phase p = phase();
        if (p != Phase.Pool) revert WrongPhase(p);
        IHunchBookFactory f = IHunchBookFactory(factory);
        if (f.graduationPaused()) revert GraduationPaused();
        if (!graduationRuleMet()) revert GraduationRuleNotMet();

        _stage = Stage.Graduated;
        graduated = true;

        address graduator = f.graduator();
        if (graduator == address(0)) revert BookNotReady();
        address b = IGraduator(graduator).bookOf(address(this));
        if (b == address(0)) {
            if (!IGraduator(graduator).canCreateBooks()) revert BookNotReady();
            b = IGraduator(graduator).createBook(address(this));
            if (b == address(0)) revert BookNotReady();
        }
        book = b;

        uint256 yesTotal = _yesTotal;
        uint256 noTotal = _noTotal;
        uint256 total = yesTotal + noTotal;
        ICollateralVault(vault).graduatePool(total);
        emit Graduated(total, yesTotal, noTotal, yesTotal * 1e6 / total, b);
    }

    /// @inheritdoc IMarket
    function claimTokens() external nonReentrant {
        if (!graduated) revert NotGraduated();
        if (!_claimTokens(msg.sender)) revert NothingToClaim();
    }

    /// @inheritdoc IMarket
    function claimTokensFor(address[] calldata users) external nonReentrant {
        if (!graduated) revert NotGraduated();
        for (uint256 i; i < users.length; ++i) {
            _claimTokens(users[i]);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Settlement
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarket
    function settle(bytes calldata evidence) external payable nonReentrant {
        _requireOpen();
        if (!_reached(_window.close)) revert NotClosed();
        if (block.timestamp > _window.settleDeadline) revert PastSettleDeadline();

        (Outcome o, bytes32 h) = resolver.resolve{value: msg.value}(_params, evidence);
        if (o == Outcome.Unresolved) revert NotResolved();
        _finalize(o, h);
        _refundValue();
    }

    /// @inheritdoc IMarket
    function proveYes(bytes calldata proof) external payable nonReentrant {
        _requireOpen();
        if (!resolver.earlyYes()) revert NotEarlyYes();
        Phase p = phase();
        if (p == Phase.Pool) revert WrongPhase(p);
        if (block.timestamp > _window.settleDeadline) revert PastSettleDeadline();

        (Outcome o, bytes32 h) = resolver.resolve{value: msg.value}(_params, proof);
        if (o != Outcome.Yes) revert NotResolved();
        _finalize(o, h);
        _refundValue();
    }

    /// @inheritdoc IMarket
    function voidIfExpired() external nonReentrant {
        _requireOpen();
        if (block.timestamp <= _window.settleDeadline) revert NotExpired();
        _stage = Stage.Voided;
        ICollateralVault(vault).finalizeVoid();
        emit Voided();
    }

    /// @inheritdoc IMarket
    function claimPool() external nonReentrant {
        _requirePoolClaimable();
        if (!_claimPool(msg.sender)) revert NothingToClaim();
    }

    /// @inheritdoc IMarket
    function claimPoolFor(address[] calldata users) external nonReentrant {
        _requirePoolClaimable();
        for (uint256 i; i < users.length; ++i) {
            _claimPool(users[i]);
        }
    }

    /// Receives the unused part of a resolver fee (Pyth), refunded to the settler in the same call.
    receive() external payable {}

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IMarket
    function phase() public view returns (Phase) {
        Stage s = _stage;
        if (s == Stage.Settled) return Phase.Settled;
        if (s == Stage.Voided) return Phase.Voided;
        if (s == Stage.Graduated) return _reached(_window.close) ? Phase.Closed : Phase.Graduated;
        return _reached(_window.lock) ? Phase.PoolLocked : Phase.Pool;
    }

    function poolTotals() external view returns (uint256 yesTotal, uint256 noTotal, uint32 stakers) {
        return (_yesTotal, _noTotal, _stakers);
    }

    function tokens() external view returns (address yes, address no) {
        return (_yes, _no);
    }

    /// @inheritdoc IMarket
    function feePerToken(Side side) external view returns (uint256) {
        if (!graduated) return 0;
        uint256 total = uint256(_yesTotal) + _noTotal;
        uint256 losing = side == Side.Yes ? _noTotal : _yesTotal;
        return FEE_BPS * losing * 1e6 / (BPS * total);
    }

    function window() external view returns (Window memory) {
        return _window;
    }

    function params() external view returns (bytes memory) {
        return _params;
    }

    function rule() external view returns (GraduationRule memory) {
        return _rule;
    }

    function caps() external view returns (MarketCaps memory) {
        return _caps;
    }

    function stakeOf(address user) external view returns (uint256 yesStake, uint256 noStake) {
        Position storage pos = _positions[user];
        return (pos.yes, pos.no);
    }

    /// @inheritdoc IMarket
    function claimableTokens(address user) public view returns (uint256 yesAmount, uint256 noAmount) {
        Position storage pos = _positions[user];
        if (!graduated || pos.tokensClaimed) return (0, 0);
        uint256 total = uint256(_yesTotal) + _noTotal;
        if (pos.yes != 0) yesAmount = uint256(pos.yes) * total / _yesTotal;
        if (pos.no != 0) noAmount = uint256(pos.no) * total / _noTotal;
    }

    /// @inheritdoc IMarket
    function claimablePool(address user) public view returns (uint256 paid, uint256 fee) {
        Stage s = _stage;
        if (graduated || (s != Stage.Settled && s != Stage.Voided)) return (0, 0);
        Position storage pos = _positions[user];
        if (pos.poolClaimed) return (0, 0);
        return _poolPayout(pos);
    }

    /// @inheritdoc IMarket
    function graduationRuleMet() public view returns (bool) {
        uint256 yesTotal = _yesTotal;
        uint256 noTotal = _noTotal;
        uint256 total = yesTotal + noTotal;
        GraduationRule memory r = _rule;
        return total >= r.minPool && _stakers >= r.minStakers && yesTotal != 0 && noTotal != 0
            && yesTotal * BPS >= uint256(r.minChanceBps) * total && yesTotal * BPS <= uint256(r.maxChanceBps) * total;
    }

    /// @inheritdoc IMarket
    function authorizationNonce(address user, Side side, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), user, side, salt));
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    function _stake(address payer, address user, Side side, uint256 amount) internal {
        _checkStake(user, amount);
        _record(user, side, amount);
        ICollateralVault(vault).depositPool(payer, amount);
    }

    /// Pulls a signed EIP-3009 transfer to this market. The nonce binds the signature to this
    /// market, the user, the side and a salt, so a relayer cannot reuse it for the other side.
    function _receiveAuthorized(
        address user,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) internal {
        if (signature.length != 65) revert BadAuthorization();
        IERC3009(_usdc)
            .receiveWithAuthorization(
                user,
                address(this),
                amount,
                validAfter,
                validBefore,
                nonce,
                uint8(signature[64]),
                bytes32(signature[0:32]),
                bytes32(signature[32:64])
            );
    }

    function _checkStake(address user, uint256 amount) internal view {
        Phase p = phase();
        if (p != Phase.Pool) revert WrongPhase(p);
        if (user == address(0)) revert ZeroAddress();
        MarketCaps memory c = _caps;
        if (amount < c.minStake) revert StakeTooSmall();
        if (uint256(_yesTotal) + _noTotal + amount > c.poolCap) revert PoolCapExceeded();
        Position storage pos = _positions[user];
        if (uint256(pos.yes) + pos.no + amount > c.walletCap) revert WalletCapExceeded();
    }

    function _record(address user, Side side, uint256 amount) internal {
        Position storage pos = _positions[user];
        if (pos.yes == 0 && pos.no == 0) ++_stakers;
        uint128 a = amount.toUint128();
        if (side == Side.Yes) {
            if (pos.yes == 0) ++_yesStakers;
            pos.yes += a;
            _yesTotal += a;
        } else {
            if (pos.no == 0) ++_noStakers;
            pos.no += a;
            _noTotal += a;
        }
        emit Staked(user, side, amount, _yesTotal, _noTotal);
    }

    /// Transfers a staker's tokens: ⌊T · s / sideTotal⌋ per side. When the last staker on a side
    /// has claimed, the rounding dust left on that side goes to the protocol fee recipient.
    function _claimTokens(address user) internal returns (bool) {
        Position storage pos = _positions[user];
        if (pos.tokensClaimed || (pos.yes == 0 && pos.no == 0)) return false;
        pos.tokensClaimed = true;

        uint256 total = uint256(_yesTotal) + _noTotal;
        if (pos.yes != 0) {
            uint256 amount = uint256(pos.yes) * total / _yesTotal;
            _yes.safeTransfer(user, amount);
            emit TokensClaimed(user, Side.Yes, amount);
            if (++_yesTokenClaims == _yesStakers) _sweepTokenDust(Side.Yes, _yes);
        }
        if (pos.no != 0) {
            uint256 amount = uint256(pos.no) * total / _noTotal;
            _no.safeTransfer(user, amount);
            emit TokensClaimed(user, Side.No, amount);
            if (++_noTokenClaims == _noStakers) _sweepTokenDust(Side.No, _no);
        }
        return true;
    }

    function _sweepTokenDust(Side side, address token) internal {
        uint256 dust = token.balanceOf(address(this));
        if (dust == 0) return;
        address to = IHunchBookFactory(factory).feeRecipient();
        token.safeTransfer(to, dust);
        emit DustSwept(side, dust, to);
    }

    function _finalize(Outcome o, bytes32 h) internal {
        outcome = o;
        evidenceHash = h;
        _stage = Stage.Settled;
        if (graduated) {
            uint256 total = uint256(_yesTotal) + _noTotal;
            uint256 losing = o == Outcome.Yes ? _noTotal : _yesTotal;
            // Redemption fee per winning token f = φ · losing / T (PROTOCOL.md §5.3).
            ICollateralVault(vault).finalize(o, FEE_BPS * losing, BPS * total);
        } else {
            ICollateralVault(vault).finalize(o, 0, 1);
        }
        emit Settled(o, h, msg.sender);
    }

    function _requirePoolClaimable() internal view {
        if (graduated) revert AlreadyGraduated();
        Stage s = _stage;
        if (s != Stage.Settled && s != Stage.Voided) revert WrongPhase(phase());
    }

    /// Pays a pool-only market (PROTOCOL.md §5.2). When the last winner has been paid, the
    /// rounding dust left in the pool moves to the fee balances.
    function _claimPool(address user) internal returns (bool) {
        Position storage pos = _positions[user];
        if (pos.poolClaimed || (pos.yes == 0 && pos.no == 0)) return false;
        (uint256 paid, uint256 fee) = _poolPayout(pos);
        if (paid == 0) return false; // a loser: nothing to pay
        pos.poolClaimed = true;

        ICollateralVault v = ICollateralVault(vault);
        v.payPool(user, paid, fee);
        emit PoolClaimed(user, paid, fee);

        if (!_refundMode()) {
            uint32 winners = outcome == Outcome.Yes ? _yesStakers : _noStakers;
            if (++_winnerClaims == winners) {
                uint256 dust = v.ledger(address(this)).pool;
                if (dust != 0) v.payPool(address(0), 0, dust);
            }
        }
        return true;
    }

    function _poolPayout(Position storage pos) internal view returns (uint256 paid, uint256 fee) {
        if (_refundMode()) return (uint256(pos.yes) + pos.no, 0);
        (uint256 s, uint256 winning, uint256 losing) = outcome == Outcome.Yes
            ? (uint256(pos.yes), uint256(_yesTotal), uint256(_noTotal))
            : (uint256(pos.no), uint256(_noTotal), uint256(_yesTotal));
        if (s == 0) return (0, 0);
        // Winnings round down, then the 2% fee on them rounds up: never pays out more than the pool.
        // (The same order as packages/shared/src/math.ts.)
        uint256 gross = s * losing / winning;
        fee = (gross * FEE_BPS + BPS - 1) / BPS;
        paid = s + gross - fee;
    }

    /// Voided, or settled with only one side staked: every stake comes back in full, no fee.
    function _refundMode() internal view returns (bool) {
        return _stage == Stage.Voided || _yesTotal == 0 || _noTotal == 0;
    }

    function _requireOpen() internal view {
        Stage s = _stage;
        if (s == Stage.Settled || s == Stage.Voided) revert WrongPhase(phase());
    }

    function _reached(uint64 point) internal view returns (bool) {
        return _window.blockClock ? block.number >= point : block.timestamp >= point;
    }

    function _refundValue() internal {
        uint256 bal = address(this).balance;
        if (bal != 0) msg.sender.safeTransferETH(bal);
    }
}
