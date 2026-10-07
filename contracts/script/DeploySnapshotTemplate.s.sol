// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {LibString} from "solady/utils/LibString.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../src/interfaces/IResolver.sol";
import {GraduationRule} from "../src/interfaces/IHunchBookTypes.sol";
import {SnapshotSource} from "../src/interfaces/ITemplatesV3.sol";
import {IPerplExchange} from "../src/interfaces/external/IPerplExchange.sol";
import {SnapshotResolver} from "../src/resolvers/SnapshotResolver.sol";

/// Template 7's sources on Perpl: each perp's open interest and mark price, read from
/// `getPerpetualInfoV2(perpId)`. The tests build their sources with this library too, so what they
/// check is what the script deploys.
library PerplSnapshotSources {
    // Word indexes in Perpl's `PerpetualInfoV2` (IPerplExchange.sol), counted from the head of the
    // returned tuple. SnapshotResolver.t.sol checks them against the struct; the fork suites check the
    // values against Perpl's live answers.
    uint16 internal constant PRICE_DECIMALS = 2;
    uint16 internal constant LOT_DECIMALS = 3;
    uint16 internal constant MARK = 11;
    uint16 internal constant MARK_TIMESTAMP = 12;
    uint16 internal constant LONG_OPEN_INTEREST = 17;
    uint16 internal constant SHORT_OPEN_INTEREST = 18;
    uint16 internal constant FUNDING_START_BLOCK = 19;
    uint16 internal constant STATUS = 22;

    /// A mark price older than this is refused: twice Perpl's own `refPriceMaxAgeSec` (60 seconds).
    /// Sampled on both networks in October 2026, the mark was never more than 50 seconds old.
    uint32 internal constant MARK_MAX_AGE = 120;

    /// "Perpl's BTC open interest (perp 1)", in BTC with the perp's lot decimals. Perpl reports long
    /// and short open interest separately; every lot has a long and a short side, so they are equal,
    /// and this reads the long side.
    function openInterest(IPerplExchange exchange, uint256 perpId, string memory asset)
        internal
        view
        returns (SnapshotSource memory s)
    {
        IPerplExchange.PerpetualInfoV2 memory info = exchange.getPerpetualInfoV2(perpId);
        s = _base(exchange, perpId);
        s.label = string.concat("Perpl's ", asset, " open interest (perp ", LibString.toString(perpId), ")");
        s.unit = asset;
        s.decimals = _toUint8(info.lotDecimals);
        s.valueWord = LONG_OPEN_INTEREST;
    }

    /// "Perpl's BTC mark price (perp 1)", in USD with the perp's price decimals, refused if older than
    /// `MARK_MAX_AGE`.
    function markPrice(IPerplExchange exchange, uint256 perpId, string memory asset)
        internal
        view
        returns (SnapshotSource memory s)
    {
        IPerplExchange.PerpetualInfoV2 memory info = exchange.getPerpetualInfoV2(perpId);
        s = _base(exchange, perpId);
        s.label = string.concat("Perpl's ", asset, " mark price (perp ", LibString.toString(perpId), ")");
        s.unit = "USD";
        s.decimals = _toUint8(info.priceDecimals);
        s.valueWord = MARK;
        s.timestampWord = MARK_TIMESTAMP;
        s.maxAge = MARK_MAX_AGE;
    }

    /// Open interest then mark price for each perp, in the order given: ids 2i and 2i + 1.
    function forPerps(IPerplExchange exchange, string[] memory assets, uint256[] memory perpIds)
        internal
        view
        returns (SnapshotSource[] memory sources)
    {
        require(assets.length == perpIds.length, "assets and perp ids differ in length");
        sources = new SnapshotSource[](2 * assets.length);
        for (uint256 i = 0; i < assets.length; ++i) {
            sources[2 * i] = openInterest(exchange, perpIds[i], assets[i]);
            sources[2 * i + 1] = markPrice(exchange, perpIds[i], assets[i]);
        }
    }

    /// What every Perpl source shares: the call, and the checks that the perp is still the one it was.
    /// Pinned: the price and lot decimals (the units), the funding start block (it moves if the id is
    /// removed and listed again), and the status (a paused perp's values stop moving). Guard: Perpl's
    /// `getContractVersion()`, the one implementation identity it exposes to contracts.
    function _base(IPerplExchange exchange, uint256 perpId) private pure returns (SnapshotSource memory s) {
        s.target = address(exchange);
        s.callData = abi.encodeCall(IPerplExchange.getPerpetualInfoV2, (perpId));
        s.tuple = true;
        s.signed = false;
        s.pinnedWords = new uint16[](4);
        (s.pinnedWords[0], s.pinnedWords[1], s.pinnedWords[2], s.pinnedWords[3]) =
        (PRICE_DECIMALS, LOT_DECIMALS, FUNDING_START_BLOCK, STATUS);
        s.guardTarget = address(exchange);
        s.guardCallData = abi.encodeCall(IPerplExchange.getContractVersion, ());
    }

    function _toUint8(uint256 v) private pure returns (uint8) {
        require(v <= type(uint8).max, "decimals do not fit in uint8");
        // Safe: checked just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(v);
    }
}

/// Deploys template 7 (docs/TEMPLATES.md) next to an existing Hunch Book deployment and records it in
/// deployments/<network>.json, the only address source every reader uses.
///
///   1. Deploy (and, if the broadcaster is the factory's guardian, register the template):
///        DEPLOYER_PRIVATE_KEY=... forge script script/DeploySnapshotTemplate.s.sol --rpc-url <rpc> \
///          --broadcast --slow
///      The address goes to `hunchBook.resolvers.snapshot` only in a broadcast run; a dry run (no
///      --broadcast, `--sender <address>` instead of a key) prints the sources and writes nothing.
///   2. Record the transaction hashes from the broadcast log, after step 1 has landed:
///        forge script script/DeploySnapshotTemplate.s.sol --sig "record()" --rpc-url <rpc>
///      This sends nothing. It checks the logged deployment against the address written in step 1 and
///      the registration against the factory's TemplateAdded event, then writes `hunchBook.deployTxs`
///      entries `snapshot` and `addTemplate7`.
///   3. Forge writes the file with sorted keys and no final newline; restore the repo's formatting with
///      `pnpm exec biome format --write deployments/` before committing it.
///
/// Sources: for each Perpl perp listed in the deployments file, in the order BTC, ETH, SOL, MON,
/// its open interest (id 2i) then its mark price (id 2i + 1). The template is registered with the
/// graduation rule of the factory's template 1. On mainnet the guardian is a multisig, so this
/// script only deploys; the multisig calls addTemplate(7) itself.
///
/// Env: DEPLOYER_PRIVATE_KEY (optional: without it the script uses the CLI sender or wallet).
contract DeploySnapshotTemplate is Script {
    uint256 internal constant TESTNET = 10_143;
    uint256 internal constant MAINNET = 143;

    uint32 internal constant TEMPLATE_SNAPSHOT = 7;

    /// How far past the deployment block `record()` looks for the TemplateAdded event.
    uint256 internal constant LOG_SEARCH_BLOCKS = 5000;
    uint256 internal constant LOG_CHUNK = 100;

    // ------------------------------------------------------------------------------------------
    // Step 1: deploy and register
    // ------------------------------------------------------------------------------------------

    function run() external {
        string memory path = _deploymentPath();
        string memory json = vm.readFile(path);
        require(
            vm.keyExistsJson(json, string.concat(_stack(), ".factory")), "Hunch Book is not deployed on this network"
        );
        require(!vm.keyExistsJson(json, string.concat(_stack(), ".resolvers.snapshot")), "template 7 already deployed");

        IHunchBookFactory factory = IHunchBookFactory(vm.parseJsonAddress(json, string.concat(_stack(), ".factory")));
        require(address(factory.resolverOf(TEMPLATE_SNAPSHOT)) == address(0), "template id 7 is already taken");
        GraduationRule memory rule = factory.templateOf(1).rule;
        require(rule.minPool != 0, "template 1 is not registered: no rule to copy");

        SnapshotSource[] memory sources = perplSources(json);
        for (uint256 i = 0; i < sources.length; ++i) {
            console2.log("source", i, sources[i].label);
        }

        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address broadcaster = pk != 0 ? vm.addr(pk) : msg.sender;
        bool isGuardian = broadcaster == factory.guardian();
        console2.log("broadcaster", broadcaster, isGuardian ? "(guardian)" : "(not the guardian)");

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        SnapshotResolver resolver = new SnapshotResolver(sources);
        if (isGuardian) factory.addTemplate(TEMPLATE_SNAPSHOT, IResolver(address(resolver)), rule);
        vm.stopBroadcast();

        console2.log("snapshot resolver", address(resolver));
        if (!isGuardian) console2.log("not registered: the guardian must call addTemplate(7)");
        _writeResolver(path, json, address(resolver));
    }

    /// Rewrites `hunchBook.resolvers` with the existing entries plus `snapshot`.
    function _writeResolver(string memory path, string memory json, address resolver) internal {
        string memory r = "resolvers";
        string[] memory existing = vm.parseJsonKeys(json, string.concat(_stack(), ".resolvers"));
        for (uint256 i = 0; i < existing.length; ++i) {
            vm.serializeAddress(
                r, existing[i], vm.parseJsonAddress(json, string.concat(_stack(), ".resolvers.", existing[i]))
            );
        }
        string memory out = vm.serializeAddress(r, "snapshot", resolver);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(out, path, string.concat(_stack(), ".resolvers"));
        } else {
            console2.log("dry run: deployments file not written");
        }
        console2.log(out);
    }

    /// Template 7's sources for the network in `json`: every perp in `external.perpl.perps`, in the
    /// order BTC, ETH, SOL, MON (assets missing from the file are skipped).
    function perplSources(string memory json) public view returns (SnapshotSource[] memory) {
        IPerplExchange exchange = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));
        string[4] memory order = ["BTC", "ETH", "SOL", "MON"];
        uint256 n = 0;
        for (uint256 i = 0; i < order.length; ++i) {
            if (vm.keyExistsJson(json, string.concat(".external.perpl.perps.", order[i]))) ++n;
        }
        string[] memory assets = new string[](n);
        uint256[] memory perpIds = new uint256[](n);
        n = 0;
        for (uint256 i = 0; i < order.length; ++i) {
            string memory key = string.concat(".external.perpl.perps.", order[i]);
            if (!vm.keyExistsJson(json, key)) continue;
            assets[n] = order[i];
            perpIds[n] = vm.parseJsonUint(json, key);
            ++n;
        }
        return PerplSnapshotSources.forPerps(exchange, assets, perpIds);
    }

    // ------------------------------------------------------------------------------------------
    // Step 2: record the transaction hashes
    // ------------------------------------------------------------------------------------------

    function record() external {
        string memory path = _deploymentPath();
        string memory json = vm.readFile(path);
        IHunchBookFactory factory = IHunchBookFactory(vm.parseJsonAddress(json, string.concat(_stack(), ".factory")));
        address deployed = vm.parseJsonAddress(json, string.concat(_stack(), ".resolvers.snapshot"));

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

        // The latest logged CREATE of the resolver, which must be the address in the file.
        VmSafe.BroadcastTxSummary memory s =
            vm.getBroadcast("SnapshotResolver", uint64(block.chainid), VmSafe.BroadcastTxType.Create);
        require(s.success, "SnapshotResolver: the logged deployment failed");
        require(s.contractAddress == deployed, "SnapshotResolver: log and deployments file differ");
        out = vm.serializeBytes32(t, "snapshot", s.txHash);
        console2.log("snapshot", deployed);
        console2.logBytes32(s.txHash);

        // The registration: the TemplateAdded event for id 7, which must point at this resolver.
        if (address(factory.resolverOf(TEMPLATE_SNAPSHOT)) == deployed) {
            bytes32 txHash = _templateAddedTx(address(factory), s.blockNumber);
            out = vm.serializeBytes32(t, "addTemplate7", txHash);
            console2.log("addTemplate", TEMPLATE_SNAPSHOT);
            console2.logBytes32(txHash);
        } else {
            console2.log("template 7 not registered yet, skipped");
        }

        vm.writeJson(out, path, string.concat(_stack(), ".deployTxs"));
        console2.log(out);
    }

    /// The transaction that emitted TemplateAdded(7) on the factory, searched in small block ranges
    /// (public RPCs limit eth_getLogs ranges).
    function _templateAddedTx(address factory, uint256 fromBlock) internal view returns (bytes32) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = IHunchBookFactory.TemplateAdded.selector;
        topics[1] = bytes32(uint256(TEMPLATE_SNAPSHOT));
        uint256 last = fromBlock + LOG_SEARCH_BLOCKS;
        if (last > block.number) last = block.number;
        for (uint256 from = fromBlock; from <= last; from += LOG_CHUNK) {
            uint256 to = from + LOG_CHUNK - 1;
            if (to > last) to = last;
            VmSafe.EthGetLogs[] memory logs = vm.eth_getLogs(from, to, factory, topics);
            if (logs.length != 0) return logs[0].transactionHash;
        }
        revert("no TemplateAdded event found for template 7");
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
