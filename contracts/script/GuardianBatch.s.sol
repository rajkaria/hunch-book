// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../src/interfaces/IResolver.sol";
import {GraduationRule} from "../src/interfaces/IHunchBookTypes.sol";

/// Writes the guardian's template registrations as a Safe Transaction Builder batch, for networks
/// where the guardian is a multisig and not the deployer (mainnet). Sends nothing.
///
///   forge script script/GuardianBatch.s.sol --rpc-url <rpc>
///
/// Output: deployments/guardian/<network>-add-templates.json. In the Safe app, open
/// Apps > Transaction Builder > drag the file in, review every call, then create the batch.
/// Each call is `addTemplate(templateId, resolver, rule)` on the factory, with the v0 graduation rule.
/// Templates already registered on the factory are skipped, so the file can be regenerated safely.
contract GuardianBatch is Script {
    struct Entry {
        uint32 templateId;
        string key; // resolver key under .hunchBook.resolvers in the deployments file
    }

    function run() external {
        (string memory path, string memory network) = _paths();
        string memory json = vm.readFile(path);
        IHunchBookFactory factory = IHunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        address guardian = factory.guardian();

        string memory txs = "";
        uint256 count;
        Entry[] memory entries = templates();
        for (uint256 i; i < entries.length; ++i) {
            string memory key = string.concat(".hunchBook.resolvers.", entries[i].key);
            if (!vm.keyExistsJson(json, key)) continue;
            address resolver = vm.parseJsonAddress(json, key);
            if (address(factory.templateOf(entries[i].templateId).resolver) != address(0)) {
                console2.log("already registered, skipped: template", entries[i].templateId);
                continue;
            }
            bytes memory data = calldataFor(entries[i].templateId, resolver);
            txs = string.concat(txs, count == 0 ? "" : ",", _tx(address(factory), data));
            console2.log("template", entries[i].templateId, resolver);
            count++;
        }

        string memory out = string.concat(
            '{"version":"1.0","chainId":"',
            vm.toString(block.chainid),
            '","createdAt":',
            vm.toString(block.timestamp * 1000),
            ',"meta":{"name":"Hunch Book: register templates","description":"addTemplate calls on HunchBookFactory ',
            vm.toString(address(factory)),
            ' with the v0 graduation rule (500 USDC, 10 stakers, 3% to 97%).","txBuilderVersion":"1.16.5",',
            '"createdFromSafeAddress":"',
            vm.toString(guardian),
            '","createdFromOwnerAddress":""},"transactions":[',
            txs,
            "]}"
        );
        string memory target =
            string.concat(vm.projectRoot(), "/../deployments/guardian/", network, "-add-templates.json");
        vm.writeFile(target, out);
        console2.log("calls:", count);
        console2.log("wrote", target);
    }

    /// Every template the protocol ships, by id. A resolver missing from the deployments file is skipped.
    function templates() public pure returns (Entry[] memory e) {
        e = new Entry[](2);
        e[0] = Entry(1, "perplFunding");
        e[1] = Entry(2, "priceAtTime");
    }

    /// The v0 graduation rule (PROTOCOL.md §5.3), identical to the one Deploy.s.sol registers on testnet.
    function rule() public pure returns (GraduationRule memory) {
        return GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700});
    }

    function calldataFor(uint32 templateId, address resolver) public pure returns (bytes memory) {
        return abi.encodeCall(IHunchBookFactory.addTemplate, (templateId, IResolver(resolver), rule()));
    }

    function _tx(address to, bytes memory data) internal pure returns (string memory) {
        return string.concat(
            '{"to":"',
            vm.toString(to),
            '","value":"0","data":"',
            vm.toString(data),
            '","contractMethod":null,"contractInputsValues":null}'
        );
    }

    function _paths() internal view returns (string memory path, string memory network) {
        if (block.chainid == 10_143) network = "monad-testnet";
        else if (block.chainid == 143) network = "monad-mainnet";
        else revert("unknown chain");
        path = string.concat(vm.projectRoot(), "/../deployments/", network, ".json");
    }
}
