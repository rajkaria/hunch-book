// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Test-only stand-ins for Hunch Book's factory, vault and market, with the same ABI as the frozen
/// interfaces in contracts/src/interfaces for every function the maker reads or calls. No access
/// control and no real accounting: they exist so the maker's loop can run end to end on a local fork
/// before the protocol is deployed. Compiled with solc 0.8.30 (optimizer, 200 runs) into mock-hunch.ts.

interface IMockToken {
    function mint(address to, uint256 value) external;
    function burn(address from, uint256 value) external;
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

struct Window {
    bool blockClock;
    uint64 lock;
    uint64 close;
    uint64 settleDeadline;
}

contract MockHunchMarket {
    uint8 public phase;
    uint8 public outcome;
    address public book;
    address public vault;
    uint32 public templateId;
    bytes public params;
    address internal yes;
    address internal no;
    Window internal win;

    constructor(address yes_, address no_, address vault_, uint32 templateId_, bytes memory params_, Window memory w) {
        yes = yes_;
        no = no_;
        vault = vault_;
        templateId = templateId_;
        params = params_;
        win = w;
    }

    function tokens() external view returns (address, address) {
        return (yes, no);
    }

    function window() external view returns (Window memory) {
        return win;
    }

    function setPhase(uint8 phase_) external {
        phase = phase_;
    }

    function setBook(address book_) external {
        book = book_;
    }
}

contract MockHunchFactory {
    address[] internal markets;

    function add(address market) external {
        markets.push(market);
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function marketAt(uint256 index) external view returns (address) {
        return markets[index];
    }
}

contract MockHunchVault {
    address public usdc;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    /// 1 USDC in, 1 YES + 1 NO out, as CollateralVault.mintSets.
    function mintSets(address market, uint256 amount, address to) external {
        IMockToken(usdc).transferFrom(msg.sender, address(this), amount);
        (address y, address n) = MockHunchMarket(market).tokens();
        IMockToken(y).mint(to, amount);
        IMockToken(n).mint(to, amount);
    }

    /// 1 YES + 1 NO in, 1 USDC out, as CollateralVault.mergeSets.
    function mergeSets(address market, uint256 amount, address to) external {
        (address y, address n) = MockHunchMarket(market).tokens();
        IMockToken(y).burn(msg.sender, amount);
        IMockToken(n).burn(msg.sender, amount);
        IMockToken(usdc).transfer(to, amount);
    }
}
