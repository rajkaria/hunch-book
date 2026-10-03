// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Side} from "./IHunchBookTypes.sol";

/// One YES or NO token per market: a 6-decimal ERC-20 (with EIP-2612 permit), minted and burned
/// only by the vault. Deployed as a minimal clone when the market is created.
interface IOutcomeToken {
    function initialize(address vault, address market, Side side, string calldata name, string calldata symbol) external;
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;

    function vault() external view returns (address);
    function market() external view returns (address);
    function side() external view returns (Side);
}
