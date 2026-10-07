// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../src/interfaces/IResolver.sol";
import {GraduationRule} from "../src/interfaces/IHunchBookTypes.sol";
import {IPerplExchange} from "../src/interfaces/external/IPerplExchange.sol";
import {IPyth} from "../src/interfaces/external/IPyth.sol";
import {ChainlinkTouchResolver} from "../src/resolvers/ChainlinkTouchResolver.sol";
import {MarketOutcomeResolver} from "../src/resolvers/MarketOutcomeResolver.sol";
import {PerplFundingSpikeResolver} from "../src/resolvers/PerplFundingSpikeResolver.sol";
import {PriceRangeResolver} from "../src/resolvers/PriceRangeResolver.sol";

/// Deploys templates 3 to 6 (docs/TEMPLATES.md) next to an existing Hunch Book deployment and records
/// them in deployments/<network>.json, the only address source every reader uses.
///
///   1. Deploy (and, if the broadcaster is the factory's guardian, register the templates):
///        DEPLOYER_PRIVATE_KEY=... forge script script/DeployTemplatesV2.s.sol --rpc-url <rpc> \
///          --broadcast --slow
///      Addresses go to `hunchBook.resolvers` only in a broadcast run; a dry run (no --broadcast,
///      `--sender <address>` instead of a key) prints them and writes nothing.
///   2. Record the transaction hashes from the broadcast log, after step 1 has landed:
///        forge script script/DeployTemplatesV2.s.sol --sig "record()" --rpc-url <rpc>
///      This sends nothing. It checks each logged deployment against the addresses written in step 1
///      and each registration against the factory's TemplateAdded events, then writes the hashes to
///      `hunchBook.deployTxs` (chainlinkTouch, perplFundingSpike, priceRange, marketOutcome,
///      addTemplate3 to addTemplate6).
///   3. Forge writes the file with sorted keys and no final newline; restore the repo's formatting with
///      `pnpm exec biome format --write deployments/` before committing it.
///
/// Allowlists come from the deployments file, the same way Deploy.s.sol builds template 2's: every
/// Chainlink feed listed for the network; Pyth only for pairs with no Chainlink feed. Templates are
/// registered with the graduation rule of the factory's template 1. On mainnet the guardian is a
/// multisig, so this script only deploys; the multisig calls addTemplate(3..6) itself.
///
/// Env: DEPLOYER_PRIVATE_KEY (optional: without it the script uses the CLI sender or wallet).
contract DeployTemplatesV2 is Script {
    uint256 internal constant TESTNET = 10_143;
    uint256 internal constant MAINNET = 143;

    uint32 internal constant TEMPLATE_TOUCH = 3;
    uint32 internal constant TEMPLATE_FUNDING_SPIKE = 4;
    uint32 internal constant TEMPLATE_PRICE_RANGE = 5;
    uint32 internal constant TEMPLATE_PARLAY = 6;

    /// Conservative milliseconds per block for settlement deadlines, the same as template 1's.
    uint256 internal constant BLOCK_TIME_MS = 1000;

    /// Template 4's challenge period: 24 hours of blocks at 300 ms. Measured in October 2026 at about
    /// 302 ms on both Monad networks, so the period is slightly over 24 hours of wall time.
    uint256 internal constant BLOCKS_PER_DAY = 288_000;

    /// Template 6: the block time assumed when estimating the earliest lock of a block-clock leg,
    /// two thirds of the measured block time, so the estimate errs early.
    uint256 internal constant FAST_BLOCK_TIME_MS = 200;

    /// How far past the first deployment block `record()` looks for the TemplateAdded events.
    uint256 internal constant LOG_SEARCH_BLOCKS = 5000;
    uint256 internal constant LOG_CHUNK = 100;

    struct Deployed {
        address chainlinkTouch;
        address perplFundingSpike;
        address priceRange;
        address marketOutcome;
        bool registered;
    }

    string internal json;

    // ------------------------------------------------------------------------------------------
    // Step 1: deploy and register
    // ------------------------------------------------------------------------------------------

    function run() external {
        string memory path = _deploymentPath();
        json = vm.readFile(path);
        require(
            vm.keyExistsJson(json, string.concat(_stack(), ".factory")), "Hunch Book is not deployed on this network"
        );
        require(
            !vm.keyExistsJson(json, string.concat(_stack(), ".resolvers.chainlinkTouch")),
            "templates 3 to 6 already deployed"
        );

        IHunchBookFactory factory = IHunchBookFactory(vm.parseJsonAddress(json, string.concat(_stack(), ".factory")));
        for (uint32 id = TEMPLATE_TOUCH; id <= TEMPLATE_PARLAY; ++id) {
            require(address(factory.resolverOf(id)) == address(0), "a template id from 3 to 6 is already taken");
        }
        GraduationRule memory rule = factory.templateOf(1).rule;
        require(rule.minPool != 0, "template 1 is not registered: no rule to copy");

        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address broadcaster = pk != 0 ? vm.addr(pk) : msg.sender;
        bool isGuardian = broadcaster == factory.guardian();
        console2.log("broadcaster", broadcaster, isGuardian ? "(guardian)" : "(not the guardian)");

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        Deployed memory d = _deploy(factory);
        if (isGuardian) {
            factory.addTemplate(TEMPLATE_TOUCH, IResolver(d.chainlinkTouch), rule);
            factory.addTemplate(TEMPLATE_FUNDING_SPIKE, IResolver(d.perplFundingSpike), rule);
            factory.addTemplate(TEMPLATE_PRICE_RANGE, IResolver(d.priceRange), rule);
            factory.addTemplate(TEMPLATE_PARLAY, IResolver(d.marketOutcome), rule);
            d.registered = true;
        }
        vm.stopBroadcast();

        if (!d.registered) console2.log("not registered: the guardian must call addTemplate(3..6)");
        _writeResolvers(path, d);
    }

    function _deploy(IHunchBookFactory factory) internal returns (Deployed memory d) {
        (address[] memory feeds, string[] memory pairs) = _chainlinkFeeds();
        (IPyth pyth, bytes32[] memory pythIds, string[] memory labels) = _pythWithoutChainlink(pairs);

        d.chainlinkTouch = address(new ChainlinkTouchResolver(feeds));
        d.perplFundingSpike = address(
            new PerplFundingSpikeResolver(
                IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange")), BLOCK_TIME_MS, BLOCKS_PER_DAY
            )
        );
        d.priceRange = address(new PriceRangeResolver(feeds, pyth, pythIds, labels));
        d.marketOutcome = address(new MarketOutcomeResolver(factory, FAST_BLOCK_TIME_MS));
    }

    /// Every Chainlink feed the deployments file lists for this network.
    function _chainlinkFeeds() internal view returns (address[] memory feeds, string[] memory pairs) {
        pairs = vm.parseJsonKeys(json, ".external.chainlink");
        feeds = new address[](pairs.length);
        for (uint256 i = 0; i < pairs.length; ++i) {
            feeds[i] = vm.parseJsonAddress(json, string.concat(".external.chainlink['", pairs[i], "']"));
            console2.log("chainlink", pairs[i], feeds[i]);
        }
    }

    /// Pyth ids for the pairs with no Chainlink feed on this network (Pyth needs an API key to settle,
    /// so it is used only where Chainlink cannot be).
    function _pythWithoutChainlink(string[] memory chainlinkPairs)
        internal
        view
        returns (IPyth pyth, bytes32[] memory ids, string[] memory labels)
    {
        string[] memory pairs = vm.parseJsonKeys(json, ".external.pyth.ids");
        uint256 n = 0;
        bool[] memory use = new bool[](pairs.length);
        for (uint256 i = 0; i < pairs.length; ++i) {
            use[i] = !_contains(chainlinkPairs, pairs[i]);
            if (use[i]) ++n;
        }
        ids = new bytes32[](n);
        labels = new string[](n);
        n = 0;
        for (uint256 i = 0; i < pairs.length; ++i) {
            if (!use[i]) continue;
            ids[n] = vm.parseJsonBytes32(json, string.concat(".external.pyth.ids['", pairs[i], "']"));
            labels[n] = pairs[i];
            console2.log("pyth", pairs[i]);
            ++n;
        }
        if (n != 0) pyth = IPyth(vm.parseJsonAddress(json, ".external.pyth.contract"));
    }

    function _contains(string[] memory list, string memory item) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (keccak256(bytes(list[i])) == keccak256(bytes(item))) return true;
        }
        return false;
    }

    /// Rewrites `hunchBook.resolvers` with the existing entries plus the four new ones.
    function _writeResolvers(string memory path, Deployed memory d) internal {
        string memory r = "resolvers";
        string[] memory existing = vm.parseJsonKeys(json, string.concat(_stack(), ".resolvers"));
        for (uint256 i = 0; i < existing.length; ++i) {
            vm.serializeAddress(
                r, existing[i], vm.parseJsonAddress(json, string.concat(_stack(), ".resolvers.", existing[i]))
            );
        }
        vm.serializeAddress(r, "chainlinkTouch", d.chainlinkTouch);
        vm.serializeAddress(r, "perplFundingSpike", d.perplFundingSpike);
        vm.serializeAddress(r, "priceRange", d.priceRange);
        string memory out = vm.serializeAddress(r, "marketOutcome", d.marketOutcome);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(out, path, string.concat(_stack(), ".resolvers"));
        } else {
            console2.log("dry run: deployments file not written");
        }
        console2.log(out);
    }

    // ------------------------------------------------------------------------------------------
    // Step 2: record the transaction hashes
    // ------------------------------------------------------------------------------------------

    function record() external {
        string memory path = _deploymentPath();
        json = vm.readFile(path);
        IHunchBookFactory factory = IHunchBookFactory(vm.parseJsonAddress(json, string.concat(_stack(), ".factory")));
        string[4] memory keys = ["chainlinkTouch", "perplFundingSpike", "priceRange", "marketOutcome"];
        string[4] memory names =
            ["ChainlinkTouchResolver", "PerplFundingSpikeResolver", "PriceRangeResolver", "MarketOutcomeResolver"];

        string memory t = "deployTxs";
        string memory out;
        if (vm.keyExistsJson(json, string.concat(_stack(), ".deployTxs"))) {
            string[] memory existing = vm.parseJsonKeys(json, string.concat(_stack(), ".deployTxs"));
            for (uint256 i = 0; i < existing.length; ++i) {
                out = vm.serializeBytes32(
                    t, existing[i], vm.parseJsonBytes32(json, string.concat(_stack(), ".deployTxs.", existing[i]))
                );
            }
        }

        // Deployments: the latest logged CREATE of each resolver, which must be the address in the file.
        uint256 fromBlock = type(uint256).max;
        address[4] memory deployed;
        for (uint256 i = 0; i < 4; ++i) {
            deployed[i] = vm.parseJsonAddress(json, string.concat(_stack(), ".resolvers.", keys[i]));
            VmSafe.BroadcastTxSummary memory s =
                vm.getBroadcast(names[i], uint64(block.chainid), VmSafe.BroadcastTxType.Create);
            require(s.success, string.concat(names[i], ": the logged deployment failed"));
            require(s.contractAddress == deployed[i], string.concat(names[i], ": log and deployments file differ"));
            out = vm.serializeBytes32(t, keys[i], s.txHash);
            if (s.blockNumber < fromBlock) fromBlock = s.blockNumber;
            console2.log(keys[i], deployed[i]);
            console2.logBytes32(s.txHash);
        }

        // Registrations: the TemplateAdded event for each id, which must point at the new resolver.
        for (uint32 id = TEMPLATE_TOUCH; id <= TEMPLATE_PARLAY; ++id) {
            address expected = deployed[id - TEMPLATE_TOUCH];
            if (address(factory.resolverOf(id)) != expected) {
                console2.log("template not registered yet, skipped:", id);
                continue;
            }
            bytes32 txHash = _templateAddedTx(address(factory), id, fromBlock);
            out = vm.serializeBytes32(t, string.concat("addTemplate", vm.toString(id)), txHash);
            console2.log("addTemplate", id);
            console2.logBytes32(txHash);
        }

        vm.writeJson(out, path, string.concat(_stack(), ".deployTxs"));
        console2.log(out);
    }

    /// The transaction that emitted TemplateAdded(id) on the factory, searched in small block ranges
    /// (public RPCs limit eth_getLogs ranges).
    function _templateAddedTx(address factory, uint32 id, uint256 fromBlock) internal view returns (bytes32) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = IHunchBookFactory.TemplateAdded.selector;
        topics[1] = bytes32(uint256(id));
        uint256 last = fromBlock + LOG_SEARCH_BLOCKS;
        if (last > block.number) last = block.number;
        for (uint256 from = fromBlock; from <= last; from += LOG_CHUNK) {
            uint256 to = from + LOG_CHUNK - 1;
            if (to > last) to = last;
            VmSafe.EthGetLogs[] memory logs = vm.eth_getLogs(from, to, factory, topics);
            if (logs.length != 0) return logs[0].transactionHash;
        }
        revert(string.concat("no TemplateAdded event found for template ", vm.toString(id)));
    }

    // ------------------------------------------------------------------------------------------

    /// `.hunchBook`, or `.stacks.<STACK>` when STACK is set (an extra stack, e.g. kuruV2).
    function _stack() internal view returns (string memory) {
        string memory stack = vm.envOr("STACK", string(""));
        return bytes(stack).length == 0 ? ".hunchBook" : string.concat(".stacks.", stack);
    }

    function _deploymentPath() internal view returns (string memory) {
        string memory network;
        if (block.chainid == TESTNET) network = "monad-testnet";
        else if (block.chainid == MAINNET) network = "monad-mainnet";
        else revert("unknown chain");
        return string.concat(vm.projectRoot(), "/../deployments/", network, ".json");
    }
}
