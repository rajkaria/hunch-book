// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {GraduationRuleEnv} from "./GraduationRuleEnv.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../src/interfaces/IResolver.sol";
import {GraduationRule} from "../src/interfaces/IHunchBookTypes.sol";

/// The guardian's template registrations, for networks where the guardian is not the deployer
/// (mainnet). Two ways to send them:
///
/// A multisig guardian (a Safe). Write the batch, which sends nothing:
///   forge script script/GuardianBatch.s.sol --rpc-url <rpc>
/// Output: deployments/guardian/<network>-add-templates.json. In the Safe app, open
/// Apps > Transaction Builder > drag the file in, review every call, then create the batch.
///
/// A single-key guardian. Send the calls from the guardian's own wallet (never a key in a file):
///   forge script script/GuardianBatch.s.sol --sig "register()" --rpc-url <rpc> --broadcast --slow \
///     --gas-estimate-multiplier 110 --account <guardian keystore>   (or --ledger, or --interactive)
/// It stops unless the broadcaster is the factory's guardian.
///
/// Each call is `addTemplate(templateId, resolver, rule)` on the factory. The rule is template 1's once
/// template 1 is registered, so every template shares one rule; before that it is the rule from
/// GRADUATION_MIN_POOL / GRADUATION_MIN_STAKERS (GraduationRuleEnv.sol), the same variables Deploy.s.sol
/// reads. Templates already registered are skipped, so either form can be run again safely.
///
/// Then record the registration hashes in the deployments file (sends nothing):
///   FROM_BLOCK=<block> forge script script/GuardianBatch.s.sol --sig "record()" --rpc-url <rpc>
contract GuardianBatch is GraduationRuleEnv {
    struct Entry {
        uint32 templateId;
        string key; // resolver key under .hunchBook.resolvers in the deployments file
    }

    /// One pending registration.
    struct Call {
        uint32 templateId;
        address resolver;
        bytes data;
    }

    function run() external {
        (string memory path, string memory network) = _paths();
        string memory json = vm.readFile(path);
        IHunchBookFactory factory = IHunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        address guardian = factory.guardian();
        GraduationRule memory r = ruleFor(factory);
        Call[] memory calls = pending(json, factory);

        string memory txs = "";
        for (uint256 i; i < calls.length; ++i) {
            txs = string.concat(txs, i == 0 ? "" : ",", _tx(address(factory), calls[i].data));
            console2.log("template", calls[i].templateId, calls[i].resolver);
        }

        string memory out = string.concat(
            '{"version":"1.0","chainId":"',
            vm.toString(block.chainid),
            '","createdAt":',
            vm.toString(block.timestamp * 1000),
            ',"meta":{"name":"Hunch Book: register templates","description":"addTemplate calls on HunchBookFactory ',
            vm.toString(address(factory)),
            " with the graduation rule ",
            describe(r),
            '.","txBuilderVersion":"1.16.5",',
            '"createdFromSafeAddress":"',
            vm.toString(guardian),
            '","createdFromOwnerAddress":""},"transactions":[',
            txs,
            "]}"
        );
        string memory target =
            string.concat(vm.projectRoot(), "/../deployments/guardian/", network, "-add-templates.json");
        vm.writeFile(target, out);
        console2.log("rule:", describe(r));
        console2.log("calls:", calls.length);
        console2.log("wrote", target);
    }

    /// Sends every pending registration from the broadcasting wallet, which must be the guardian.
    function register() external {
        (string memory path,) = _paths();
        string memory json = vm.readFile(path);
        IHunchBookFactory factory = IHunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        require(msg.sender == factory.guardian(), "the broadcaster is not the factory's guardian");
        Call[] memory calls = pending(json, factory);
        console2.log("rule:", describe(ruleFor(factory)));

        vm.startBroadcast();
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = address(factory).call(calls[i].data);
            require(ok, "addTemplate failed");
            console2.log("registered template", calls[i].templateId, calls[i].resolver);
        }
        vm.stopBroadcast();
        console2.log("calls:", calls.length);
    }

    /// How many blocks past FROM_BLOCK `record()` searches, in steps public RPCs accept.
    uint256 internal constant LOG_SEARCH_BLOCKS = 5000;
    uint256 internal constant LOG_CHUNK = 100;

    /// After the registrations have landed: finds each template's TemplateAdded event on the factory,
    /// from FROM_BLOCK (the block of the first registration, or a little before) for up to 5,000 blocks,
    /// and writes the hashes to `hunchBook.deployTxs` as addTemplate1 to addTemplate7. Sends nothing.
    ///
    ///   FROM_BLOCK=<block> forge script script/GuardianBatch.s.sol --sig "record()" --rpc-url <rpc>
    function record() external {
        (string memory path,) = _paths();
        string memory json = vm.readFile(path);
        bytes32[] memory hashes =
            _templateAddedTxs(vm.parseJsonAddress(json, ".hunchBook.factory"), vm.envUint("FROM_BLOCK"));
        string memory out = _existingTxs(json);
        uint256 found;
        for (uint256 id = 1; id <= 7; ++id) {
            if (hashes[id] == bytes32(0)) continue;
            out = vm.serializeBytes32("deployTxs", string.concat("addTemplate", vm.toString(id)), hashes[id]);
            console2.log("addTemplate", id);
            console2.logBytes32(hashes[id]);
            ++found;
        }
        require(found != 0, "no TemplateAdded event in the searched blocks: check FROM_BLOCK");
        vm.writeJson(out, path, ".hunchBook.deployTxs");
    }

    /// The transaction of each template id's TemplateAdded event (index = id), searched in small block
    /// ranges (public RPCs limit eth_getLogs ranges).
    function _templateAddedTxs(address factory, uint256 from) internal view returns (bytes32[] memory hashes) {
        uint256 last = from + LOG_SEARCH_BLOCKS;
        if (last > block.number) last = block.number;
        hashes = new bytes32[](8);
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = IHunchBookFactory.TemplateAdded.selector;
        for (uint256 start = from; start <= last; start += LOG_CHUNK) {
            uint256 end = start + LOG_CHUNK - 1;
            if (end > last) end = last;
            VmSafe.EthGetLogs[] memory logs = vm.eth_getLogs(start, end, factory, topics);
            for (uint256 i; i < logs.length; ++i) {
                uint256 id = uint256(logs[i].topics[1]);
                if (id >= 1 && id <= 7 && hashes[id] == bytes32(0)) hashes[id] = logs[i].transactionHash;
            }
        }
    }

    /// `hunchBook.deployTxs` as it is, serialized under "deployTxs" so new entries add to it.
    function _existingTxs(string memory json) internal returns (string memory out) {
        string memory txs = ".hunchBook.deployTxs";
        if (!vm.keyExistsJson(json, txs)) return "";
        string[] memory existing = vm.parseJsonKeys(json, txs);
        for (uint256 i; i < existing.length; ++i) {
            bytes32 h = vm.parseJsonBytes32(json, string.concat(txs, ".", existing[i]));
            out = vm.serializeBytes32("deployTxs", existing[i], h);
        }
    }

    /// The registrations still to make: every template whose resolver is in the deployments file and
    /// whose id is free on the factory, in id order.
    function pending(string memory json, IHunchBookFactory factory) public view returns (Call[] memory calls) {
        Entry[] memory entries = templates();
        GraduationRule memory r = ruleFor(factory);
        Call[] memory all = new Call[](entries.length);
        uint256 n;
        for (uint256 i; i < entries.length; ++i) {
            string memory key = string.concat(".hunchBook.resolvers.", entries[i].key);
            if (!vm.keyExistsJson(json, key)) continue;
            address resolver = vm.parseJsonAddress(json, key);
            if (address(factory.templateOf(entries[i].templateId).resolver) != address(0)) {
                console2.log("already registered, skipped: template", entries[i].templateId);
                continue;
            }
            all[n++] = Call(entries[i].templateId, resolver, calldataFor(entries[i].templateId, resolver, r));
        }
        calls = new Call[](n);
        for (uint256 i; i < n; ++i) {
            calls[i] = all[i];
        }
    }

    /// Every template the protocol ships, by id. A resolver missing from the deployments file is skipped.
    function templates() public pure returns (Entry[] memory e) {
        e = new Entry[](7);
        e[0] = Entry(1, "perplFunding");
        e[1] = Entry(2, "priceAtTime");
        e[2] = Entry(3, "chainlinkTouch");
        e[3] = Entry(4, "perplFundingSpike");
        e[4] = Entry(5, "priceRange");
        e[5] = Entry(6, "marketOutcome");
        e[6] = Entry(7, "snapshot");
    }

    /// Template 1's rule once it is registered, otherwise the rule from the environment.
    function ruleFor(IHunchBookFactory factory) public view returns (GraduationRule memory) {
        GraduationRule memory first = factory.templateOf(1).rule;
        return first.minPool != 0 ? first : graduationRule();
    }

    /// The rule from the environment (PROTOCOL.md §5.3): by default the v0 rule Deploy.s.sol registers
    /// on testnet.
    function rule() public view returns (GraduationRule memory) {
        return graduationRule();
    }

    function calldataFor(uint32 templateId, address resolver) public view returns (bytes memory) {
        return calldataFor(templateId, resolver, rule());
    }

    function calldataFor(uint32 templateId, address resolver, GraduationRule memory r)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IHunchBookFactory.addTemplate, (templateId, IResolver(resolver), r));
    }

    /// "(500 USDC, 10 stakers, 3% to 97%)".
    function describe(GraduationRule memory r) public pure returns (string memory) {
        return string.concat(
            "(",
            vm.toString(uint256(r.minPool) / 1e6),
            " USDC, ",
            vm.toString(uint256(r.minStakers)),
            " stakers, ",
            vm.toString(uint256(r.minChanceBps) / 100),
            "% to ",
            vm.toString(uint256(r.maxChanceBps) / 100),
            "%)"
        );
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
