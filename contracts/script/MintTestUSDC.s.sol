// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";

/// Testnet only. Mints Hunch Book's test USDC (anyone may mint up to its faucet limit per call) to TO, for
/// example our maker bot's inventory or a tester's wallet, sent from the deployer key in the environment.
///
///   TO=0x... AMOUNT_USDC=20000 forge script script/MintTestUSDC.s.sol:MintTestUSDC --rpc-url monad_testnet --broadcast
contract MintTestUSDC is Script {
    function run() external {
        require(block.chainid == 10_143, "testnet only");
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        TestUSDC usdc = TestUSDC(vm.parseJsonAddress(json, ".hunchBook.usdc"));
        address to = vm.envAddress("TO");
        uint256 left = vm.envUint("AMOUNT_USDC") * 1e6;
        uint256 limit = usdc.FAUCET_LIMIT();

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        while (left != 0) {
            uint256 amount = left > limit ? limit : left;
            usdc.mint(to, amount);
            left -= amount;
        }
        vm.stopBroadcast();
        console2.log("test USDC balance of", to, usdc.balanceOf(to));
    }
}
