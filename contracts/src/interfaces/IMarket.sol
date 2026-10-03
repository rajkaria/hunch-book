// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {GraduationRule, MarketCaps, Outcome, Phase, Side, Window} from "./IHunchBookTypes.sol";
import {IResolver} from "./IResolver.sol";

/// One yes/no question. A minimal clone created by the factory. Holds no USDC (the vault does);
/// holds YES/NO tokens only between graduation and each staker's claim.
interface IMarket {
    event Staked(address indexed user, Side side, uint256 amount, uint256 yesTotal, uint256 noTotal);
    event Graduated(uint256 total, uint256 yesTotal, uint256 noTotal, uint256 openingPriceE6, address book);
    event TokensClaimed(address indexed user, Side side, uint256 amount);
    event Settled(Outcome outcome, bytes32 evidenceHash, address settler);
    event Voided();
    event PoolClaimed(address indexed user, uint256 paid, uint256 fee);
    event DustSwept(Side side, uint256 amount, address to);

    error WrongPhase(Phase phase);
    error StakeTooSmall();
    error PoolCapExceeded();
    error WalletCapExceeded();
    error GraduationPaused();
    error GraduationRuleNotMet();
    error BookNotReady();
    error NotClosed();
    error PastSettleDeadline();
    error NotExpired();
    error NotResolved();
    error NotEarlyYes();
    error NothingToClaim();
    error NotGraduated();
    error AlreadyGraduated();
    error BadAuthorization();
    error OnlyFactory();

    // ---- staking (Pool phase) ----

    /// Stake `amount` USDC on `side`. USDC is pulled from the caller by the vault
    /// (approve the vault once, not each market).
    function stake(Side side, uint256 amount) external;

    /// Stake on behalf of `user`; the caller pays. Used by relayers and by the factory for the first stake.
    function stakeFor(address user, Side side, uint256 amount) external;

    /// Relayed stake from a signed USDC EIP-3009 `receiveWithAuthorization` (to = this market).
    /// The EIP-3009 nonce must equal `authorizationNonce(user, side, salt)`, which binds the
    /// signature to this market and side so a relayer cannot redirect it.
    function stakeWithAuthorization(
        address user,
        Side side,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature
    ) external;

    // ---- lifecycle ----

    /// Anyone, while the market is a POOL, if the graduation rule holds and a Kuru book is ready.
    function graduate() external;

    /// Claim your YES/NO tokens after graduation (any later phase).
    function claimTokens() external;

    /// Push token claims to many stakers; anyone can call. Skips addresses with nothing to claim.
    function claimTokensFor(address[] calldata users) external;

    /// Anyone, after close and up to the settlement deadline. `evidence` is forwarded to the resolver.
    function settle(bytes calldata evidence) external payable;

    /// Touch templates only: settle YES early from a proof the resolver checks.
    function proveYes(bytes calldata proof) external payable;

    /// Anyone, after the settlement deadline, if the market has not settled.
    function voidIfExpired() external;

    /// Pool-only markets after settlement or void: pays winnings or refunds the caller's stake.
    function claimPool() external;

    /// Same as `claimPool` for each listed user; anyone can call. Skips users with nothing to claim.
    function claimPoolFor(address[] calldata users) external;

    // ---- views ----

    function phase() external view returns (Phase);
    function poolTotals() external view returns (uint256 yesTotal, uint256 noTotal, uint32 stakers);
    function outcome() external view returns (Outcome);
    function tokens() external view returns (address yes, address no);
    function book() external view returns (address);
    /// Redemption fee per winning token, in USDC base units per 1e6 token units (1 token).
    function feePerToken(Side side) external view returns (uint256);
    function window() external view returns (Window memory);

    function factory() external view returns (address);
    function vault() external view returns (address);
    function marketId() external view returns (uint256);
    function templateId() external view returns (uint32);
    function resolver() external view returns (IResolver);
    function params() external view returns (bytes memory);
    function creator() external view returns (address);
    function rule() external view returns (GraduationRule memory);
    function caps() external view returns (MarketCaps memory);
    function graduated() external view returns (bool);
    function evidenceHash() external view returns (bytes32);

    /// What `user` staked on each side.
    function stakeOf(address user) external view returns (uint256 yesStake, uint256 noStake);
    /// Tokens `user` can still claim (0 before graduation or after claiming).
    function claimableTokens(address user) external view returns (uint256 yesAmount, uint256 noAmount);
    /// Pool-only payout `user` can still claim, and the fee withheld from it.
    function claimablePool(address user) external view returns (uint256 paid, uint256 fee);
    /// True if the graduation rule holds right now, ignoring book readiness and pauses.
    function graduationRuleMet() external view returns (bool);
    /// The EIP-3009 nonce a user must sign for `stakeWithAuthorization`.
    function authorizationNonce(address user, Side side, bytes32 salt) external view returns (bytes32);
}
