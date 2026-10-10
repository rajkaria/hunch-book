// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IKuruMarginAccount} from "../interfaces/external/IKuruMarginAccount.sol";

/// @title HunchMarginAccount
/// @notice Holds every token on Hunch Book's own order books (docs/PROTOCOL.md §8.1, "Hunch order book").
/// It has the parts of Kuru v1's MarginAccount that Hunch Book's graduator, router and maker call, so they
/// work against it unchanged. It has no owner, no pause and no fees.
///
/// Two kinds of balance, per token:
/// - a user's free balance: deposited, or credited by fills. Only the user can withdraw it, at any time.
/// - a book's escrow: what backs that book's resting orders and the taker order it is matching right now.
///   Only that book can move it, and only to a user (`release`, `payOut`). A book can never touch another
///   book's escrow or anyone's free balance except by `lock`, which the book calls only for the order's
///   own owner (HunchOrderBook places orders for msg.sender only).
///
/// Solvency: for every token, `tracked[token]` = sum of free balances + sum of book escrows, and the
/// contract's token balance is at least that (tests/venue invariants). `escrowIn` lets a book claim only
/// tokens that have actually arrived and are not yet tracked.
///
/// Books: only the HunchOrderBookFactory that deployed this contract can mark a book verified, and it does
/// so for books it created itself. `verifiedMarket(book)` is what the Graduator checks.
contract HunchMarginAccount is IKuruMarginAccount {
    using SafeTransferLib for address;

    error InsufficientBalance();
    error ZeroAddressNotAllowed();
    error NativeAssetMismatch();
    error OnlyVerifiedMarketsAllowed();
    error OnlyFactory();
    error UntrackedTokensMissing();

    event Deposit(address owner, address token, uint256 amount);
    event Withdrawal(address owner, address token, uint256 amount);
    event BookVerified(address indexed book);

    /// The HunchOrderBookFactory that deployed this contract and alone verifies books.
    address public immutable factory;

    /// @inheritdoc IKuruMarginAccount
    mapping(address book => bool) public verifiedMarket;

    /// Free balances.
    mapping(address user => mapping(address token => uint256)) internal _balances;
    /// What each book holds for its resting orders (and, inside one call, its taker order).
    mapping(address book => mapping(address token => uint256)) public escrowOf;
    /// Sum of all free balances and escrows, per token.
    mapping(address token => uint256) public tracked;

    modifier onlyBook() {
        if (!verifiedMarket[msg.sender]) revert OnlyVerifiedMarketsAllowed();
        _;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddressNotAllowed();
        factory = factory_;
    }

    // ---------------------------------------------------------------- users

    /// @inheritdoc IKuruMarginAccount
    /// @dev Pulls exactly `_amount` from the caller and credits `_user`. Native MON is not supported.
    function deposit(address _user, address _token, uint256 _amount) external payable {
        if (msg.value != 0) revert NativeAssetMismatch();
        if (_user == address(0) || _token == address(0)) revert ZeroAddressNotAllowed();
        _token.safeTransferFrom(msg.sender, address(this), _amount);
        _balances[_user][_token] += _amount;
        tracked[_token] += _amount;
        emit Deposit(_user, _token, _amount);
    }

    /// Withdraws `_amount` of the caller's free balance of `_token`.
    function withdraw(uint256 _amount, address _token) external {
        _withdraw(msg.sender, _token, _amount);
    }

    /// @inheritdoc IKuruMarginAccount
    function batchWithdrawMaxTokens(address[] calldata _tokens) external {
        for (uint256 i; i < _tokens.length; ++i) {
            uint256 amount = _balances[msg.sender][_tokens[i]];
            if (amount != 0) _withdraw(msg.sender, _tokens[i], amount);
        }
    }

    /// @inheritdoc IKuruMarginAccount
    function getBalance(address _user, address _token) external view returns (uint256) {
        return _balances[_user][_token];
    }

    // ---------------------------------------------------------------- factory

    /// Marks a book the factory has just created as verified. Only the factory.
    function registerBook(address book) external {
        if (msg.sender != factory) revert OnlyFactory();
        verifiedMarket[book] = true;
        emit BookVerified(book);
    }

    // ---------------------------------------------------------------- books

    /// Moves `amount` of `user`'s free balance into the calling book's escrow.
    function lock(address user, address token, uint256 amount) external onlyBook {
        uint256 free = _balances[user][token];
        if (free < amount) revert InsufficientBalance();
        unchecked {
            _balances[user][token] = free - amount;
        }
        escrowOf[msg.sender][token] += amount;
    }

    /// Moves `amount` of the calling book's escrow into `user`'s free balance.
    function release(address user, address token, uint256 amount) external onlyBook {
        if (amount == 0) return;
        _spendEscrow(msg.sender, token, amount);
        _balances[user][token] += amount;
    }

    /// Adds `amount` of `token` that the calling book has just transferred here to its escrow. Reverts
    /// unless at least that much has arrived untracked, so a book cannot claim tokens nobody sent.
    function escrowIn(address token, uint256 amount) external onlyBook {
        uint256 total = tracked[token] + amount;
        if (token.balanceOf(address(this)) < total) revert UntrackedTokensMissing();
        tracked[token] = total;
        escrowOf[msg.sender][token] += amount;
    }

    /// Sends `amount` of the calling book's escrow to `to`'s wallet.
    function payOut(address token, address to, uint256 amount) external onlyBook {
        if (amount == 0) return;
        _spendEscrow(msg.sender, token, amount);
        tracked[token] -= amount;
        token.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- internals

    function _withdraw(address user, address token, uint256 amount) internal {
        uint256 free = _balances[user][token];
        if (free < amount) revert InsufficientBalance();
        unchecked {
            _balances[user][token] = free - amount;
        }
        tracked[token] -= amount;
        token.safeTransfer(user, amount);
        emit Withdrawal(user, token, amount);
    }

    function _spendEscrow(address book, address token, uint256 amount) internal {
        uint256 held = escrowOf[book][token];
        if (held < amount) revert InsufficientBalance();
        unchecked {
            escrowOf[book][token] = held - amount;
        }
    }
}
