// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibClone} from "solady/utils/LibClone.sol";
import {IHunchBookFactory} from "../interfaces/IHunchBookFactory.sol";
import {IResolver} from "../interfaces/IResolver.sol";
import {GraduationRule, MarketCaps, Side, Window} from "../interfaces/IHunchBookTypes.sol";
import {CollateralVault} from "./CollateralVault.sol";
import {Market} from "./Market.sol";

/// @title HunchBookFactory
/// @notice Creates one market per (template, params), keeps the template registry and the limits
/// for new markets, and deploys the vault so the vault trusts exactly this factory.
///
/// The guardian (a multisig in production) can pause creation and graduation, add templates and
/// set limits for markets created afterwards. It cannot pause settlement, redemption, merges or
/// refunds, change an existing market, set outcomes or move funds. No function here can.
contract HunchBookFactory is IHunchBookFactory {
    address public immutable vault;
    address public immutable usdc;
    address public immutable marketImplementation;
    /// May wire the graduator once, then has no powers.
    address public immutable deployer;

    address public graduator;
    address public guardian;
    address public pendingGuardian;
    address public feeRecipient;
    bool public creationPaused;
    bool public graduationPaused;

    MarketCaps internal _caps;
    mapping(uint32 templateId => Template) internal _templates;
    mapping(bytes32 key => address) public marketOf;
    mapping(address => bool) public isMarket;
    address[] internal _markets;

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert OnlyGuardian();
        _;
    }

    constructor(
        address usdc_,
        address marketImplementation_,
        address guardian_,
        address feeRecipient_,
        MarketCaps memory caps_,
        uint256 collateralCap_
    ) {
        if (
            usdc_ == address(0) || marketImplementation_ == address(0) || guardian_ == address(0)
                || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        _validateCaps(caps_);
        usdc = usdc_;
        marketImplementation = marketImplementation_;
        deployer = msg.sender;
        guardian = guardian_;
        feeRecipient = feeRecipient_;
        _caps = caps_;
        vault = address(new CollateralVault(usdc_, collateralCap_));

        emit GuardianTransferred(address(0), guardian_);
        emit FeeRecipientUpdated(address(0), feeRecipient_);
        emit CapsUpdated(caps_);
        emit CollateralCapUpdated(collateralCap_);
    }

    // ------------------------------------------------------------------------------------------
    // Anyone
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IHunchBookFactory
    function createMarket(uint32 templateId, bytes calldata params, Side firstSide, uint256 firstStake)
        external
        returns (address market)
    {
        if (creationPaused) revert CreationIsPaused();
        Template memory t = _templates[templateId];
        if (address(t.resolver) == address(0)) revert UnknownTemplate();

        bytes32 key = marketKey(templateId, params);
        if (marketOf[key] != address(0)) revert MarketExists();

        Window memory w = t.resolver.validate(params);
        _validateWindow(w);
        MarketCaps memory c = _caps;
        if (firstStake < c.creatorMinStake) revert FirstStakeTooSmall();

        market = LibClone.cloneDeterministic(marketImplementation, key);
        marketOf[key] = market;
        isMarket[market] = true;
        _markets.push(market);
        uint256 id = _markets.length;

        Market.InitParams memory p;
        p.vault = vault;
        p.usdc = usdc;
        p.marketId = id;
        p.templateId = templateId;
        p.resolver = t.resolver;
        p.params = params;
        p.window = w;
        p.rule = t.rule;
        p.caps = c;
        p.creator = msg.sender;
        p.firstSide = firstSide;
        p.firstStake = firstStake;
        (p.yes, p.no) = CollateralVault(vault).registerMarket(market, msg.sender, id);
        Market(payable(market)).initialize(p);

        emit MarketCreated(market, templateId, key, msg.sender, params);
    }

    // ------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IHunchBookFactory
    function marketKey(uint32 templateId, bytes calldata params) public pure returns (bytes32) {
        return keccak256(abi.encode(templateId, params));
    }

    function resolverOf(uint32 templateId) external view returns (IResolver) {
        return _templates[templateId].resolver;
    }

    function templateOf(uint32 templateId) external view returns (Template memory) {
        return _templates[templateId];
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 index) external view returns (address) {
        return _markets[index];
    }

    function caps() external view returns (MarketCaps memory) {
        return _caps;
    }

    // ------------------------------------------------------------------------------------------
    // Guardian
    // ------------------------------------------------------------------------------------------

    /// @inheritdoc IHunchBookFactory
    /// @dev Templates are append-only: an id, once used, always points at the same resolver and rule.
    function addTemplate(uint32 templateId, IResolver resolver, GraduationRule calldata rule) external onlyGuardian {
        if (address(resolver) == address(0)) revert ZeroAddress();
        if (address(_templates[templateId].resolver) != address(0)) revert TemplateExists();
        if (
            rule.minPool == 0 || rule.minStakers == 0 || rule.minChanceBps >= rule.maxChanceBps
                || rule.maxChanceBps > 10_000
        ) revert BadRule();
        _templates[templateId] = Template({resolver: resolver, rule: rule});
        emit TemplateAdded(templateId, address(resolver), rule);
    }

    function setCreationPaused(bool paused) external onlyGuardian {
        creationPaused = paused;
        emit CreationPaused(paused);
    }

    function setGraduationPaused(bool paused) external onlyGuardian {
        graduationPaused = paused;
        emit GraduationPausedSet(paused);
    }

    /// @dev Applies to markets created afterwards; every existing market keeps the caps it copied.
    function setCaps(MarketCaps calldata caps_) external onlyGuardian {
        _validateCaps(caps_);
        _caps = caps_;
        emit CapsUpdated(caps_);
    }

    /// @dev Limits new deposits and mints only. Settlement, redemption, merges and refunds ignore it.
    function setCollateralCap(uint256 cap) external onlyGuardian {
        CollateralVault(vault).setCollateralCap(cap);
        emit CollateralCapUpdated(cap);
    }

    function transferGuardian(address pending) external onlyGuardian {
        pendingGuardian = pending;
        emit GuardianTransferStarted(guardian, pending);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert OnlyPendingGuardian();
        emit GuardianTransferred(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    // ------------------------------------------------------------------------------------------
    // Fee recipient and deployer
    // ------------------------------------------------------------------------------------------

    function setFeeRecipient(address recipient) external {
        if (msg.sender != feeRecipient) revert OnlyFeeRecipient();
        if (recipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, recipient);
        feeRecipient = recipient;
    }

    /// @dev One-time wiring, because the graduator is deployed after the factory it points at.
    function setGraduator(address graduator_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (graduator != address(0)) revert GraduatorAlreadySet();
        if (graduator_ == address(0)) revert ZeroAddress();
        graduator = graduator_;
        emit GraduatorSet(graduator_);
    }

    // ------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------

    function _validateWindow(Window memory w) internal view {
        if (w.blockClock) {
            if (w.lock <= block.number || w.close < w.lock) revert BadWindow();
        } else {
            if (w.lock <= block.timestamp || w.close < w.lock || w.settleDeadline <= w.close) revert BadWindow();
        }
        if (w.settleDeadline <= block.timestamp) revert BadWindow();
    }

    function _validateCaps(MarketCaps memory c) internal pure {
        // poolCap is also the Kuru book's maxSize, a uint96.
        if (
            c.minStake == 0 || c.creatorMinStake < c.minStake || c.walletCap < c.creatorMinStake
                || c.poolCap < c.walletCap || c.poolCap > type(uint96).max
        ) revert BadCaps();
    }
}
