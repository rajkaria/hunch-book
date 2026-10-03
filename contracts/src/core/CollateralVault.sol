// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibClone} from "solady/utils/LibClone.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ICollateralVault} from "../interfaces/ICollateralVault.sol";
import {IFlashLoanReceiver} from "../interfaces/IFlashLoanReceiver.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IMarket} from "../interfaces/IMarket.sol";
import {IOutcomeToken} from "../interfaces/IOutcomeToken.sol";
import {Outcome, Phase, Side} from "../interfaces/IHunchBookTypes.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// @title CollateralVault
/// @notice Holds every USDC in Hunch Book and keeps one ledger per market.
///
/// Solvency: `USDC.balanceOf(this) >= totalObligations` after every call, where
/// `totalObligations = Σ pool + Σ sets + protocolFees + Σ creatorFees`.
/// Every function moves balance and obligations together, and `flashLoan` checks that the
/// surplus did not fall across the callback.
///
/// The vault is deployed by its factory and trusts only markets that factory registered.
/// Nobody can move funds out except through the rules below: pool payouts the market computes,
/// merges, redemptions, and fee withdrawals by the fee recipient and each creator.
contract CollateralVault is ICollateralVault {
    using SafeTransferLib for address;
    using SafeCastLib for uint256;

    bytes32 internal constant FLASH_CALLBACK_SUCCESS = keccak256("HunchBook.onFlashLoan");
    uint256 internal constant CREATOR_SHARE_BPS = 2500;
    uint256 internal constant BPS = 10_000;

    address public immutable usdc;
    address public immutable factory;
    address public immutable tokenImplementation;

    mapping(address market => Ledger) internal _ledgers;

    /// Σ pool + Σ sets + protocolFees + Σ creatorFees.
    uint256 public totalObligations;
    /// Σ pool + Σ sets: the USDC at risk in markets, limited by `collateralCap` on deposits and mints.
    uint256 public totalCollateral;
    uint256 public collateralCap;
    uint256 public protocolFees;
    mapping(address creator => uint256) public creatorFees;

    uint256 private _lock = 1;
    uint256 private _flashLock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    /// The caller must be a market this vault registered.
    modifier onlyMarket() {
        if (_ledgers[msg.sender].status == Status.Unregistered) revert OnlyMarket();
        _;
    }

    constructor(address usdc_, uint256 collateralCap_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        factory = msg.sender;
        tokenImplementation = address(new OutcomeToken());
        collateralCap = collateralCap_;
    }

    // ------------------------------------------------------------------------------------------
    // Anyone
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ICollateralVault
    function mintSets(address market, uint256 amount, address to) external nonReentrant {
        Ledger storage l = _openLedger(market);
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (IMarket(market).phase() != Phase.Graduated) revert NotTradable();
        _checkCap(amount);

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        l.sets += amount.toUint128();
        totalCollateral += amount;
        totalObligations += amount;

        IOutcomeToken(l.yes).mint(to, amount);
        IOutcomeToken(l.no).mint(to, amount);
        emit SetsMinted(market, msg.sender, to, amount);
    }

    /// @inheritdoc ICollateralVault
    function mergeSets(address market, uint256 amount, address to) external nonReentrant {
        Ledger storage l = _ledgers[market];
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (l.status == Status.Open) {
            Phase p = IMarket(market).phase();
            if (p != Phase.Graduated && p != Phase.Closed) revert NotMergeable();
        } else if (l.status != Status.Voided) {
            revert NotMergeable();
        }

        IOutcomeToken(l.yes).burn(msg.sender, amount);
        IOutcomeToken(l.no).burn(msg.sender, amount);
        l.sets -= amount.toUint128();
        totalCollateral -= amount;
        totalObligations -= amount;

        usdc.safeTransfer(to, amount);
        emit SetsMerged(market, msg.sender, to, amount);
    }

    /// @inheritdoc ICollateralVault
    function redeem(address market, Side side, uint256 amount, address to)
        external
        nonReentrant
        returns (uint256 paid)
    {
        Ledger storage l = _ledgers[market];
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        if (l.status == Status.Settled) {
            Side winning = l.outcome == Outcome.Yes ? Side.Yes : Side.No;
            if (side != winning) revert LosingSide();
            IOutcomeToken(side == Side.Yes ? l.yes : l.no).burn(msg.sender, amount);

            uint256 fee = FixedPointMathLib.mulDivUp(amount, l.feeNumerator, l.feeDenominator);
            paid = amount - fee;
            l.sets -= amount.toUint128();
            totalCollateral -= amount;
            // The fee stays owed (to the fee balances), so obligations fall only by what leaves.
            totalObligations -= paid;
            _accrueFees(market, l.creator, fee);
            emit Redeemed(market, msg.sender, to, side, amount, paid, fee);
        } else if (l.status == Status.Voided) {
            IOutcomeToken(side == Side.Yes ? l.yes : l.no).burn(msg.sender, amount);
            // 0.50 USDC per token. Rounding down keeps the ledger at or above what is still owed.
            paid = amount / 2;
            l.sets -= paid.toUint128();
            totalCollateral -= paid;
            totalObligations -= paid;
            emit Redeemed(market, msg.sender, to, side, amount, paid, 0);
        } else {
            revert NotRedeemable();
        }

        if (paid != 0) usdc.safeTransfer(to, paid);
    }

    /// @inheritdoc ICollateralVault
    /// @dev Has its own lock, separate from the one on ledger functions, so the receiver can mint,
    /// merge or stake inside the callback. The surplus check makes any extraction revert.
    function flashLoan(address receiver, uint256 amount, bytes calldata data) external {
        if (_flashLock != 1) revert Reentrancy();
        _flashLock = 2;
        if (amount == 0) revert ZeroAmount();

        int256 surplusBefore = surplus();
        usdc.safeTransfer(receiver, amount);
        if (IFlashLoanReceiver(receiver).onFlashLoan(msg.sender, amount, data) != FLASH_CALLBACK_SUCCESS) {
            revert FlashLoanCallbackFailed();
        }
        usdc.safeTransferFrom(receiver, address(this), amount);
        if (surplus() < surplusBefore) revert SolvencyBreached();

        emit FlashLoan(receiver, msg.sender, amount);
        _flashLock = 1;
    }

    /// @inheritdoc ICollateralVault
    function surplus() public view returns (int256) {
        return int256(usdc.balanceOf(address(this))) - int256(totalObligations);
    }

    // ------------------------------------------------------------------------------------------
    // Fees
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ICollateralVault
    function withdrawProtocolFees(address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != IHunchBookFactory(factory).feeRecipient()) revert OnlyFeeRecipient();
        if (to == address(0)) revert ZeroAddress();
        amount = protocolFees;
        protocolFees = 0;
        totalObligations -= amount;
        if (amount != 0) usdc.safeTransfer(to, amount);
        emit ProtocolFeesWithdrawn(to, amount);
    }

    /// @inheritdoc ICollateralVault
    function withdrawCreatorFees(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = creatorFees[msg.sender];
        creatorFees[msg.sender] = 0;
        totalObligations -= amount;
        if (amount != 0) usdc.safeTransfer(to, amount);
        emit CreatorFeesWithdrawn(msg.sender, to, amount);
    }

    // ------------------------------------------------------------------------------------------
    // Factory only
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ICollateralVault
    function registerMarket(address market, address creator, uint256 marketId)
        external
        onlyFactory
        returns (address yes, address no)
    {
        if (market == address(0) || creator == address(0)) revert ZeroAddress();
        Ledger storage l = _ledgers[market];
        if (l.status != Status.Unregistered) revert MarketNotOpen();

        yes = LibClone.cloneDeterministic(tokenImplementation, keccak256(abi.encode(market, Side.Yes)));
        no = LibClone.cloneDeterministic(tokenImplementation, keccak256(abi.encode(market, Side.No)));
        string memory id = LibString.toString(marketId);
        IOutcomeToken(yes)
            .initialize(
                address(this),
                market,
                Side.Yes,
                string.concat("Hunch Book #", id, " YES"),
                string.concat("HB", id, "-YES")
            );
        IOutcomeToken(no)
            .initialize(
                address(this), market, Side.No, string.concat("Hunch Book #", id, " NO"), string.concat("HB", id, "-NO")
            );

        l.status = Status.Open;
        l.yes = yes;
        l.no = no;
        l.creator = creator;
        emit MarketRegistered(market, yes, no, creator);
    }

    /// @inheritdoc ICollateralVault
    function setCollateralCap(uint256 cap) external onlyFactory {
        collateralCap = cap;
    }

    // ------------------------------------------------------------------------------------------
    // Market only
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc ICollateralVault
    /// @dev Markets only pass the staker who called them (or the payer for `stakeFor`).
    function depositPool(address from, uint256 amount) external nonReentrant onlyMarket {
        Ledger storage l = _openLedger(msg.sender);
        if (amount == 0) revert ZeroAmount();
        _checkCap(amount);

        usdc.safeTransferFrom(from, address(this), amount);
        l.pool += amount.toUint128();
        totalCollateral += amount;
        totalObligations += amount;
        emit PoolDeposited(msg.sender, from, amount);
    }

    /// @inheritdoc ICollateralVault
    /// @dev For stakes the market received itself (EIP-3009) and forwarded here. Reverts unless the
    /// USDC actually arrived, so a credit can never exceed what the vault holds beyond its obligations.
    function creditPool(uint256 amount) external nonReentrant onlyMarket {
        Ledger storage l = _openLedger(msg.sender);
        if (amount == 0) revert ZeroAmount();
        _checkCap(amount);
        if (surplus() < int256(amount)) revert InsufficientPool();

        l.pool += amount.toUint128();
        totalCollateral += amount;
        totalObligations += amount;
        emit PoolDeposited(msg.sender, msg.sender, amount);
    }

    /// @inheritdoc ICollateralVault
    function graduatePool(uint256 total) external nonReentrant onlyMarket {
        Ledger storage l = _openLedger(msg.sender);
        if (total == 0 || total != l.pool) revert InsufficientPool();

        // Pool collateral becomes complete sets: obligations and collateral are unchanged.
        l.pool = 0;
        l.sets += total.toUint128();
        IOutcomeToken(l.yes).mint(msg.sender, total);
        IOutcomeToken(l.no).mint(msg.sender, total);
        emit PoolGraduated(msg.sender, total);
    }

    /// @inheritdoc ICollateralVault
    function payPool(address to, uint256 paid, uint256 fee) external nonReentrant onlyMarket {
        Ledger storage l = _ledgers[msg.sender];
        if (l.status != Status.Settled && l.status != Status.Voided) revert MarketNotOpen();
        uint256 total = paid + fee;
        if (total > l.pool) revert InsufficientPool();

        l.pool -= total.toUint128();
        totalCollateral -= total;
        totalObligations -= paid;
        _accrueFees(msg.sender, l.creator, fee);

        if (paid != 0) {
            if (to == address(0)) revert ZeroAddress();
            usdc.safeTransfer(to, paid);
        }
        emit PoolPaid(msg.sender, to, paid, fee);
    }

    /// @inheritdoc ICollateralVault
    function finalize(Outcome outcome, uint256 feeNumerator, uint256 feeDenominator) external onlyMarket {
        Ledger storage l = _openLedger(msg.sender);
        if (outcome == Outcome.Unresolved || feeDenominator == 0 || feeNumerator > feeDenominator) {
            revert NotRedeemable();
        }
        l.status = Status.Settled;
        l.outcome = outcome;
        l.feeNumerator = feeNumerator.toUint128();
        l.feeDenominator = feeDenominator.toUint128();
        emit Finalized(msg.sender, outcome, feeNumerator, feeDenominator);
    }

    /// @inheritdoc ICollateralVault
    function finalizeVoid() external onlyMarket {
        Ledger storage l = _openLedger(msg.sender);
        l.status = Status.Voided;
        emit MarketVoided(msg.sender);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    function ledger(address market) external view returns (Ledger memory) {
        return _ledgers[market];
    }

    function tokensOf(address market) external view returns (address yes, address no) {
        Ledger storage l = _ledgers[market];
        return (l.yes, l.no);
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    function _openLedger(address market) internal view returns (Ledger storage l) {
        l = _ledgers[market];
        if (l.status == Status.Unregistered) revert UnknownMarket();
        if (l.status != Status.Open) revert MarketNotOpen();
    }

    function _checkCap(uint256 amount) internal view {
        if (totalCollateral + amount > collateralCap) revert CollateralCapExceeded();
    }

    /// Splits a fee 75% protocol, 25% the market's creator. The fee was already part of
    /// `totalObligations`; it just moves from a market ledger to the fee balances.
    function _accrueFees(address market, address creator, uint256 fee) internal {
        if (fee == 0) return;
        uint256 creatorShare = fee * CREATOR_SHARE_BPS / BPS;
        uint256 protocolShare = fee - creatorShare;
        protocolFees += protocolShare;
        if (creatorShare != 0) creatorFees[creator] += creatorShare;
        emit FeesAccrued(market, protocolShare, creator, creatorShare);
    }
}
