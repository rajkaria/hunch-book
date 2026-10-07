// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {Deploy} from "./Deploy.s.sol";

/// Wires Kuru v2 into a stack deployed with WIRE_KURU=0 (mainnet before Kuru's v2 addresses existed):
/// deploys GraduatorV2 and HunchRouterV2 against `.external.kuruV2`, makes the GraduatorV2 the factory's
/// graduator (one-time; only the factory's deployer can do it, so DEPLOYER_PRIVATE_KEY must be the key
/// that deployed the stack), and writes `graduator`, `router` and `kuruVersion` 2 into the stack.
///
///   DEPLOYER_PRIVATE_KEY=... forge script script/WireKuruV2.s.sol --rpc-url <rpc> --broadcast
///
/// Then deploy the periphery for the stack (script/DeployPeriphery.s.sol): it needs the router.
/// Env: DEPLOYER_PRIVATE_KEY; STACK (an extra stack's name; default the primary stack);
/// KURU_TAKER_FEE_PPS / KURU_MAKER_FEE_PPS as in Deploy.s.sol.
contract WireKuruV2 is Deploy {
    function run() external override {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory path = _deploymentPath();
        string memory stack = stackPath();
        string memory j = vm.readFile(path);
        address factory = vm.parseJsonAddress(j, string.concat(stack, ".factory"));
        address usdc = vm.parseJsonAddress(j, string.concat(stack, ".usdc"));
        (address graduator, address router) = wire(key, factory, usdc);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(_quoted(graduator), path, string.concat(stack, ".graduator"));
            vm.writeJson(_quoted(router), path, string.concat(stack, ".router"));
            vm.writeJson("2", path, string.concat(stack, ".kuruVersion"));
        } else {
            console2.log("dry run: deployments file not written");
        }
        console2.log("graduator", graduator);
        console2.log("router", router);
    }

    function _quoted(address a) internal pure returns (string memory) {
        return string.concat("\"", vm.toString(a), "\"");
    }

    /// Deploys and wires from `key` for `factory`; returns the addresses without writing them. The fork
    /// tests call it.
    function wire(uint256 key, address factory, address usdc) public returns (address graduator, address router) {
        require(HunchBookFactory(factory).graduator() == address(0), "this stack already has a graduator");
        require(HunchBookFactory(factory).deployer() == vm.addr(key), "only the factory's deployer can wire it");

        vm.startBroadcast(key);
        (graduator, router) = deployKuruV2(factory, usdc);
        HunchBookFactory(factory).setGraduator(graduator);
        vm.stopBroadcast();
    }
}
