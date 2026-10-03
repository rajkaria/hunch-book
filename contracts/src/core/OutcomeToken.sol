// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";
import {IOutcomeToken} from "../interfaces/IOutcomeToken.sol";
import {Side} from "../interfaces/IHunchBookTypes.sol";

/// @title OutcomeToken
/// @notice A market's YES or NO token. 6 decimals, so one token redeems for at most 1 USDC.
/// Minimal clones of one implementation; only the vault can mint or burn.
contract OutcomeToken is ERC20, IOutcomeToken {
    error AlreadyInitialized();
    error OnlyVault();

    address public vault;
    address public market;
    Side public side;
    string private _name;
    string private _symbol;

    /// The implementation itself can never be initialized.
    constructor() {
        vault = address(0xdead);
    }

    function initialize(address vault_, address market_, Side side_, string calldata name_, string calldata symbol_)
        external
    {
        if (vault != address(0)) revert AlreadyInitialized();
        vault = vault_;
        market = market_;
        side = side_;
        _name = name_;
        _symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != vault) revert OnlyVault();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != vault) revert OnlyVault();
        _burn(from, amount);
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// No standing infinite allowance for Permit2: holders approve what they choose.
    function _givePermit2InfiniteAllowance() internal pure override returns (bool) {
        return false;
    }
}
