// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";

/// @title TestUSDC
/// @notice Testnet collateral only. A 6-decimal token that behaves like Circle USDC for everything
/// Hunch Book uses (EIP-2612 permit, EIP-3009 transfer/receive with authorization), with a public,
/// capped faucet. Kuru's testnet USDC cannot be minted, so the testnet deployment uses this.
/// Never deployed on mainnet, where the vault uses native Circle USDC.
contract TestUSDC is ERC20 {
    error FaucetLimit();
    error AuthorizationAlreadyUsed();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();
    error CallerMustBePayee();

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    /// Most a single faucet call can mint: 10,000 USDC.
    uint256 public constant FAUCET_LIMIT = 10_000e6;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address authorizer => mapping(bytes32 nonce => bool)) public authorizationState;

    function name() public pure override returns (string memory) {
        return "Hunch Book Test USDC";
    }

    function symbol() public pure override returns (string memory) {
        return "tUSDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// EIP-712 domain version, as Circle's FiatToken exposes it.
    function version() external pure returns (string memory) {
        return "1";
    }

    /// Anyone can mint up to FAUCET_LIMIT per call, to themselves or someone else.
    function mint(address to, uint256 amount) external {
        if (amount > FAUCET_LIMIT) revert FaucetLimit();
        _mint(to, amount);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _useAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s);
        _transfer(from, to, value);
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce))
            )
        );
        if (ECDSA.tryRecover(digest, v, r, s) != from || from == address(0)) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }
}
