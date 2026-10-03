// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// The parts of Kuru's MarginAccount that Hunch Book uses. Signatures match
/// Kuru-contracts-dex-public `MarginAccount.sol` and the deployed contracts on Monad.
/// Limit-order funds and fills live here; market orders on the wallet path never touch a user's
/// margin balance.
interface IKuruMarginAccount {
    /// True only for books Kuru's Router created (`Router.deployProxy` registers each new book).
    function verifiedMarket(address market) external view returns (bool);

    /// Credits `_user` with `_amount` of `_token`, pulled from the caller.
    function deposit(address _user, address _token, uint256 _amount) external payable;

    function getBalance(address _user, address _token) external view returns (uint256);

    /// Withdraws the caller's whole balance of each token. (The deployed MarginAccount on Monad
    /// testnet and mainnet has no `withdraw(uint256,address)` selector; this one exists.)
    function batchWithdrawMaxTokens(address[] calldata _tokens) external;
}
