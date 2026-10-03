// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {GraduationRule, MarketCaps, Side} from "./IHunchBookTypes.sol";
import {IResolver} from "./IResolver.sol";

/// Creates markets (one per template + params), keeps the template registry and the limits for
/// new markets. Deploys the vault in its constructor, so the vault trusts exactly one factory.
/// The guardian can pause creation and graduation, add templates and set limits for markets
/// created later. It cannot touch settlement, redemption, merges, refunds or funds.
interface IHunchBookFactory {
    struct Template {
        IResolver resolver;
        GraduationRule rule;
    }

    event MarketCreated(
        address indexed market, uint32 indexed templateId, bytes32 indexed key, address creator, bytes params
    );
    event TemplateAdded(uint32 indexed templateId, address resolver, GraduationRule rule);
    event CreationPaused(bool paused);
    event GraduationPausedSet(bool paused);
    event CapsUpdated(MarketCaps caps);
    event CollateralCapUpdated(uint256 cap);
    event GraduatorSet(address graduator);
    event GuardianTransferStarted(address indexed current, address indexed pending);
    event GuardianTransferred(address indexed previous, address indexed current);
    event FeeRecipientUpdated(address indexed previous, address indexed current);

    error CreationIsPaused();
    error UnknownTemplate();
    error TemplateExists();
    error MarketExists();
    error BadWindow();
    error FirstStakeTooSmall();
    error OnlyGuardian();
    error OnlyPendingGuardian();
    error OnlyFeeRecipient();
    error OnlyDeployer();
    error GraduatorAlreadySet();
    error ZeroAddress();
    error BadRule();
    error BadCaps();

    /// Creates the market and makes the creator's first stake (USDC pulled by the vault from the caller).
    function createMarket(uint32 templateId, bytes calldata params, Side firstSide, uint256 firstStake)
        external
        returns (address market);

    /// key = keccak256(abi.encode(templateId, params))
    function marketOf(bytes32 key) external view returns (address);
    function marketKey(uint32 templateId, bytes calldata params) external pure returns (bytes32);
    function resolverOf(uint32 templateId) external view returns (IResolver);
    function templateOf(uint32 templateId) external view returns (Template memory);
    function isMarket(address market) external view returns (bool);
    function marketCount() external view returns (uint256);
    function marketAt(uint256 index) external view returns (address);

    function vault() external view returns (address);
    function usdc() external view returns (address);
    function graduator() external view returns (address);
    function marketImplementation() external view returns (address);
    function guardian() external view returns (address);
    function pendingGuardian() external view returns (address);
    function feeRecipient() external view returns (address);
    function creationPaused() external view returns (bool);
    function graduationPaused() external view returns (bool);
    function caps() external view returns (MarketCaps memory);

    // ---- guardian ----
    function addTemplate(uint32 templateId, IResolver resolver, GraduationRule calldata rule) external;
    function setCreationPaused(bool paused) external;
    function setGraduationPaused(bool paused) external;
    function setCaps(MarketCaps calldata caps) external;
    function setCollateralCap(uint256 cap) external;
    function transferGuardian(address pending) external;
    function acceptGuardian() external;

    // ---- fee recipient ----
    function setFeeRecipient(address recipient) external;

    // ---- one-time wiring by the deployer ----
    function setGraduator(address graduator) external;
}
