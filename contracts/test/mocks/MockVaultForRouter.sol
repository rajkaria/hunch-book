// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IFlashLoanReceiver} from "../../src/interfaces/IFlashLoanReceiver.sol";
import {Phase} from "../../src/interfaces/IHunchBookTypes.sol";
import {IMarket} from "../../src/interfaces/IMarket.sol";

/// A 6-decimal (configurable) test token. Anyone can mint and burn: tests and the mock vault use it
/// for USDC, YES and NO, and fork tests use it as the Kuru book's base and quote.
contract MockTokenForRouter is ERC20 {
    string private _name;
    string private _symbol;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function _givePermit2InfiniteAllowance() internal pure override returns (bool) {
        return false;
    }
}

/// The `ICollateralVault` semantics HunchRouter relies on, and nothing else:
/// - `mintSets(market, k, to)`: only while the market is Graduated; pulls k USDC from the caller
///   (transferFrom, so the caller approves the vault) and mints k YES + k NO to `to`.
/// - `mergeSets(market, k, to)`: burns k YES + k NO from the caller (no allowance) and pays k USDC.
/// - `flashLoan(receiver, k, data)`: sends k USDC, calls `onFlashLoan(msg.sender, k, data)`, requires
///   the magic value, pulls k back with transferFrom, and requires the surplus not to have fallen.
///   Minting and merging inside the callback are allowed.
/// Test hooks can deliver a tampered callback to check the router's guards.
contract MockVaultForRouter {
    using SafeTransferLib for address;

    error NotTradable();
    error FlashLoanCallbackFailed();
    error SolvencyBreached();

    bytes32 internal constant FLASH_CALLBACK_SUCCESS = keccak256("HunchBook.onFlashLoan");

    address public immutable usdc;
    uint256 public totalSets;
    mapping(address market => uint256) public sets;

    /// Test hooks: added to the amount, or replacing the data, passed to the next callback.
    uint256 public tamperAmount;
    bytes public tamperData;
    bool public tamperDataOn;

    uint256 public flashLoans;
    uint256 public mints;
    uint256 public merges;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    function mintSets(address market, uint256 amount, address to) external {
        if (IMarket(market).phase() != Phase.Graduated) revert NotTradable();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        sets[market] += amount;
        totalSets += amount;
        (address yes, address no) = IMarket(market).tokens();
        MockTokenForRouter(yes).mint(to, amount);
        MockTokenForRouter(no).mint(to, amount);
        ++mints;
    }

    function mergeSets(address market, uint256 amount, address to) external {
        Phase p = IMarket(market).phase();
        if (p != Phase.Graduated && p != Phase.Closed && p != Phase.Voided) revert NotTradable();
        (address yes, address no) = IMarket(market).tokens();
        MockTokenForRouter(yes).burn(msg.sender, amount);
        MockTokenForRouter(no).burn(msg.sender, amount);
        sets[market] -= amount;
        totalSets -= amount;
        usdc.safeTransfer(to, amount);
        ++merges;
    }

    function flashLoan(address receiver, uint256 amount, bytes calldata data) external {
        int256 before = surplus();
        usdc.safeTransfer(receiver, amount);
        bytes memory cbData = data;
        if (tamperDataOn) cbData = tamperData;
        if (
            IFlashLoanReceiver(receiver).onFlashLoan(msg.sender, amount + tamperAmount, cbData)
                != FLASH_CALLBACK_SUCCESS
        ) revert FlashLoanCallbackFailed();
        usdc.safeTransferFrom(receiver, address(this), amount);
        if (surplus() < before) revert SolvencyBreached();
        ++flashLoans;
    }

    function surplus() public view returns (int256) {
        return int256(usdc.balanceOf(address(this))) - int256(totalSets);
    }

    // ---- test hooks ----

    function setTamper(uint256 amountDelta, bool dataOn, bytes calldata data) external {
        tamperAmount = amountDelta;
        tamperDataOn = dataOn;
        tamperData = data;
    }

    /// Calls `onFlashLoan` as the vault without lending anything.
    function callOnFlashLoan(address receiver, address initiator, uint256 amount, bytes calldata data)
        external
        returns (bytes32)
    {
        return IFlashLoanReceiver(receiver).onFlashLoan(initiator, amount, data);
    }
}
