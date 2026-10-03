// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

/// Every external address in deployments/<network>.json must have code on that network.
/// Run with: FOUNDRY_PROFILE=fork forge test
contract DeploymentsForkTest is Test {
    function test_testnetExternalAddressesHaveCode() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        assertEq(block.chainid, vm.parseJsonUint(json, ".chainId"));

        _assertCode(json, ".external.kuru.router");
        _assertCode(json, ".external.kuru.marginAccount");
        _assertCode(json, ".external.perpl.exchange");
        _assertCode(json, ".external.pyth.contract");
        _assertCode(json, ".external.circleUsdc");
        _assertCode(json, ".external.chainlink['BTC/USD']");
        _assertCode(json, ".external.chainlink['ETH/USD']");
    }

    function test_mainnetExternalAddressesHaveCode() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, vm.parseJsonUint(json, ".chainId"));

        _assertCode(json, ".external.usdc");
        _assertCode(json, ".external.kuru.router");
        _assertCode(json, ".external.kuru.marginAccount");
        _assertCode(json, ".external.perpl.exchange");
        _assertCode(json, ".external.pyth.contract");
        _assertCode(json, ".external.chainlink['BTC/USD']");
        _assertCode(json, ".external.chainlink['ETH/USD']");
        _assertCode(json, ".external.chainlink['MON/USD']");
        _assertCode(json, ".external.chainlink['SOL/USD']");
    }

    function _assertCode(string memory json, string memory key) internal view {
        address a = vm.parseJsonAddress(json, key);
        assertGt(a.code.length, 0, key);
    }
}
