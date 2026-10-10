// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

/// Moves testnet MON between Hunch Book's own service wallets (deployer, keeper, maker) so the one that
/// needs gas has it. Keys come from the environment (forge loads the checkout's .env); nothing is passed
/// on the command line.
///
///   FROM=MAKER TO=0x... AMOUNT_MILLI=2500 forge script script/MoveGas.s.sol:MoveGas --rpc-url monad_testnet --broadcast
///
/// FROM is DEPLOYER, KEEPER or MAKER (reads <FROM>_PRIVATE_KEY); AMOUNT_MILLI is thousandths of a MON.
/// Testnet only, and the sender keeps at least 0.5 MON.
contract MoveGas is Script {
    uint256 internal constant TESTNET = 10_143;
    uint256 internal constant KEEP = 0.5 ether;

    function run() external {
        require(block.chainid == TESTNET, "testnet only");
        string memory from = vm.envString("FROM");
        bytes32 f = keccak256(bytes(from));
        require(
            f == keccak256("DEPLOYER") || f == keccak256("KEEPER") || f == keccak256("MAKER"),
            "FROM must be DEPLOYER, KEEPER or MAKER"
        );
        uint256 key = vm.envUint(string.concat(from, "_PRIVATE_KEY"));
        address to = vm.envAddress("TO");
        uint256 amount = vm.envUint("AMOUNT_MILLI") * 1e15;
        address sender = vm.addr(key);
        require(sender.balance >= amount + KEEP, "sender would drop below 0.5 MON");

        vm.startBroadcast(key);
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "transfer failed");
        vm.stopBroadcast();
        console2.log("moved (milli-MON) from", from, vm.envUint("AMOUNT_MILLI"));
        console2.log("to", to);
    }
}
