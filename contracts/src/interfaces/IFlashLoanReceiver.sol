// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IFlashLoanReceiver {
    /// Called by the vault after it sends `amount` USDC. Must approve the vault for `amount` and
    /// return `keccak256("HunchBook.onFlashLoan")`; the vault then pulls `amount` back.
    function onFlashLoan(address initiator, uint256 amount, bytes calldata data) external returns (bytes32);
}
