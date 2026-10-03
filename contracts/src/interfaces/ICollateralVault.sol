// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Outcome, Side} from "./IHunchBookTypes.sol";

/// Holds every USDC in the protocol, with a ledger per market. Mints and burns complete sets.
/// Solvency: USDC.balanceOf(vault) >= totalObligations() after every call, including flash loans.
interface ICollateralVault {
    enum Status {
        Unregistered,
        Open,
        Settled,
        Voided
    }

    struct Ledger {
        Status status;
        Outcome outcome; // set when Settled
        address yes;
        address no;
        address creator;
        uint128 pool; // USDC staked while the market is a pool
        uint128 sets; // complete sets outstanding; after settlement, USDC still owed to token holders
        uint128 feeNumerator; // per-token redemption fee = amount * feeNumerator / feeDenominator
        uint128 feeDenominator;
    }

    event MarketRegistered(address indexed market, address yes, address no, address creator);
    event PoolDeposited(address indexed market, address indexed from, uint256 amount);
    event PoolGraduated(address indexed market, uint256 sets);
    event PoolPaid(address indexed market, address indexed to, uint256 paid, uint256 fee);
    event SetsMinted(address indexed market, address indexed payer, address indexed to, uint256 amount);
    event SetsMerged(address indexed market, address indexed holder, address indexed to, uint256 amount);
    event Finalized(address indexed market, Outcome outcome, uint256 feeNumerator, uint256 feeDenominator);
    event MarketVoided(address indexed market);
    event Redeemed(
        address indexed market,
        address indexed holder,
        address indexed to,
        Side side,
        uint256 amount,
        uint256 paid,
        uint256 fee
    );
    event FeesAccrued(address indexed market, uint256 protocolShare, address indexed creator, uint256 creatorShare);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);
    event CreatorFeesWithdrawn(address indexed creator, address indexed to, uint256 amount);
    event FlashLoan(address indexed receiver, address indexed initiator, uint256 amount);

    error OnlyFactory();
    error OnlyMarket();
    error OnlyFeeRecipient();
    error UnknownMarket();
    error MarketNotOpen();
    error NotTradable();
    error NotMergeable();
    error NotRedeemable();
    error LosingSide();
    error CollateralCapExceeded();
    error InsufficientPool();
    error ZeroAmount();
    error ZeroAddress();
    error FlashLoanCallbackFailed();
    error SolvencyBreached();
    error Reentrancy();

    // ---- anyone ----

    /// Pay `amount` USDC, receive `amount` YES + `amount` NO. Only while the market is GRADUATED (before close).
    function mintSets(address market, uint256 amount, address to) external;

    /// Burn `amount` YES + `amount` NO from the caller, receive `amount` USDC.
    /// Allowed once graduated and until settlement, and after a void. Not after settlement.
    function mergeSets(address market, uint256 amount, address to) external;

    /// Burn `amount` tokens of `side` from the caller. Settled: winning side pays 1 − fee per token,
    /// losing side reverts. Voided: either side pays 0.50 per token, no fee.
    function redeem(address market, Side side, uint256 amount, address to) external returns (uint256 paid);

    /// Lends `amount` USDC to `receiver`, calls `IFlashLoanReceiver.onFlashLoan`, then pulls `amount`
    /// back. Reverts unless the vault's surplus did not decrease. No fee.
    function flashLoan(address receiver, uint256 amount, bytes calldata data) external;

    /// USDC balance minus everything owed (pools, sets, fees). Never negative.
    function surplus() external view returns (int256);

    // ---- fees ----
    function withdrawProtocolFees(address to) external returns (uint256 amount);
    function withdrawCreatorFees(address to) external returns (uint256 amount);

    // ---- factory only ----
    function registerMarket(address market, address creator, uint256 marketId)
        external
        returns (address yes, address no);
    function setCollateralCap(uint256 cap) external;

    // ---- market only (msg.sender is the market) ----
    function depositPool(address from, uint256 amount) external;
    function creditPool(uint256 amount) external;
    function graduatePool(uint256 total) external;
    function payPool(address to, uint256 paid, uint256 fee) external;
    function finalize(Outcome outcome, uint256 feeNumerator, uint256 feeDenominator) external;
    function finalizeVoid() external;

    // ---- views ----
    function usdc() external view returns (address);
    function factory() external view returns (address);
    function tokenImplementation() external view returns (address);
    function ledger(address market) external view returns (Ledger memory);
    function tokensOf(address market) external view returns (address yes, address no);
    function totalObligations() external view returns (uint256);
    function totalCollateral() external view returns (uint256);
    function collateralCap() external view returns (uint256);
    function protocolFees() external view returns (uint256);
    function creatorFees(address creator) external view returns (uint256);
}
