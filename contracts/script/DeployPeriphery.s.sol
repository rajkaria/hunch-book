// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {AutoRedeemer} from "../src/periphery/AutoRedeemer.sol";
import {ConditionalOrders} from "../src/periphery/ConditionalOrders.sol";
import {ImpliedProbabilityOracle} from "../src/periphery/ImpliedProbabilityOracle.sol";
import {MerkleDistributor} from "../src/periphery/MerkleDistributor.sol";
import {OutcomeTokenPriceAdapterFactory} from "../src/periphery/OutcomeTokenPriceAdapterFactory.sol";
import {ReferralRegistry} from "../src/periphery/ReferralRegistry.sol";
import {TemplateTimelock} from "../src/periphery/TemplateTimelock.sol";
import {IOutcomeTokenPriceAdapterFactory} from "../src/periphery/interfaces/IOutcomeTokenPriceAdapterFactory.sol";

/// Deploys the periphery contracts (docs/PERIPHERY.md) against a network's deployed core, read from
/// deployments/<network>.json, and writes their addresses under `<stack>.periphery`. The stack is the
/// primary one (`.hunchBook`) unless STACK names an extra one (`.stacks.<STACK>`, e.g. STACK=kuruV2).
/// ConditionalOrders and the oracle read books for the stack's Kuru version (`<stack>.kuruVersion`,
/// absent = 1). Only a broadcast run writes the file; a dry run prints what it would write.
///
///   Dry run (no key needed):
///     forge script script/DeployPeriphery.s.sol --rpc-url <rpc> --sender <deployer address>
///   Deploy (the key is read from the environment, never passed on the command line):
///     DEPLOYER_PRIVATE_KEY=... forge script script/DeployPeriphery.s.sol --rpc-url <rpc> --broadcast
///   Then record the transaction hashes from forge's broadcast log:
///     forge script script/DeployPeriphery.s.sol --sig "recordTxs()" --rpc-url <rpc>
///
/// The TemplateTimelock is deployed but NOT made the factory's guardian. Handing it the guardian
/// role is a separate guardian action (factory.transferGuardian(timelock), then anyone calls
/// timelock.acceptGuardian()), documented in docs/PERIPHERY.md.
///
/// Env (all optional on testnet):
///   TIMELOCK_PROPOSER   the timelock's proposer; default the current guardian. Required on mainnet,
///                       and must not be the deployer.
///   TIMELOCK_DELAY      seconds; default 2 days (the minimum).
///   DISTRIBUTOR_FUNDER  the MerkleDistributor's funder; default the protocol fee recipient.
///   STACK               an extra stack's name under `.stacks`; default the primary stack.
contract DeployPeriphery is Script {
    uint256 internal constant TESTNET = 10_143;
    uint256 internal constant MAINNET = 143;

    /// How long a referral binding lasts.
    uint256 public constant REFERRAL_DURATION = 180 days;
    uint256 public constant DEFAULT_TIMELOCK_DELAY = 2 days;

    struct Config {
        address factory;
        address router;
        address proposer;
        address funder;
        uint256 timelockDelay;
        uint8 kuruVersion;
    }

    struct Deployed {
        address autoRedeemer;
        address conditionalOrders;
        address referralRegistry;
        address merkleDistributor;
        address impliedProbabilityOracle;
        address priceAdapterFactory;
        address kuruFeedFactory;
        address templateTimelock;
        address timelockProposer;
        uint256 timelockDelay;
        address distributorFunder;
        uint256 referralDuration;
        uint256 deployBlock;
    }

    function run() external {
        string memory json = vm.readFile(_deploymentPath());
        string memory stack = stackPath();
        require(vm.keyExistsJson(json, string.concat(stack, ".factory")), "core is not deployed on this stack");
        require(!vm.keyExistsJson(json, string.concat(stack, ".periphery")), "periphery already deployed on this stack");

        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = key != 0 ? vm.addr(key) : msg.sender;
        Config memory c = config(json, deployer);
        Deployed memory d = deploy(key, c);
        _write(d);
    }

    /// The configuration for this network: the core addresses from `json` and the env overrides.
    function config(string memory json, address deployer) public view returns (Config memory c) {
        string memory stack = stackPath();
        c.factory = vm.parseJsonAddress(json, string.concat(stack, ".factory"));
        c.router = vm.parseJsonAddress(json, string.concat(stack, ".router"));
        c.timelockDelay = vm.envOr("TIMELOCK_DELAY", DEFAULT_TIMELOCK_DELAY);
        c.funder = vm.envOr("DISTRIBUTOR_FUNDER", vm.parseJsonAddress(json, string.concat(stack, ".feeRecipient")));
        string memory versionKey = string.concat(stack, ".kuruVersion");
        // forge-lint: disable-next-line(unsafe-typecast)
        c.kuruVersion = vm.keyExistsJson(json, versionKey) ? uint8(vm.parseJsonUint(json, versionKey)) : 1;
        if (block.chainid == MAINNET) {
            c.proposer = vm.envAddress("TIMELOCK_PROPOSER");
            require(c.proposer != deployer, "mainnet timelock proposer must be a multisig, not the deployer");
        } else {
            c.proposer = vm.envOr("TIMELOCK_PROPOSER", vm.parseJsonAddress(json, string.concat(stack, ".guardian")));
        }
    }

    /// Deploys everything with `key` (or, with key 0, the script's sender) and returns the addresses
    /// without writing them anywhere. `run` calls it; the fork tests call it directly.
    function deploy(uint256 key, Config memory c) public returns (Deployed memory d) {
        IHunchBookFactory factory = IHunchBookFactory(c.factory);
        require(factory.vault() != address(0), "factory has no vault");
        d.timelockProposer = c.proposer;
        d.timelockDelay = c.timelockDelay;
        d.distributorFunder = c.funder;
        d.referralDuration = REFERRAL_DURATION;
        d.deployBlock = block.number;

        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        d.autoRedeemer = address(new AutoRedeemer(factory));
        d.conditionalOrders = address(new ConditionalOrders(factory, c.router, c.kuruVersion));
        d.referralRegistry = address(new ReferralRegistry(REFERRAL_DURATION));
        d.merkleDistributor = address(new MerkleDistributor(c.funder));
        ImpliedProbabilityOracle oracle = new ImpliedProbabilityOracle(factory, c.kuruVersion);
        d.impliedProbabilityOracle = address(oracle);
        d.priceAdapterFactory = address(new OutcomeTokenPriceAdapterFactory(oracle, adapterParams()));
        d.kuruFeedFactory = address(new OutcomeTokenPriceAdapterFactory(oracle, kuruFeedParams()));
        d.templateTimelock = address(new TemplateTimelock(factory, c.proposer, c.timelockDelay));
        vm.stopBroadcast();
    }

    /// Haircut parameters for the price adapters (docs/PERIPHERY.md, V-7): a 30-minute average; 10%
    /// off far from close, ramping to 100% at close over the last 3 days; plus the average spread,
    /// at most 20%; block-clock markets estimate time with 0.4 s blocks (lower is more conservative).
    function adapterParams() public pure returns (IOutcomeTokenPriceAdapterFactory.AdapterParams memory) {
        return IOutcomeTokenPriceAdapterFactory.AdapterParams({
            twapWindow: 30 minutes,
            baseHaircutBps: 1000,
            closeHaircutBps: 10_000,
            rampSeconds: 3 days,
            spreadMultiplierBps: 10_000,
            maxSpreadHaircutBps: 2000,
            blockTimeMs: 400
        });
    }

    /// Parameters for the feeds Kuru's WithdrawalLimiter prices YES and NO with (PROTOCOL.md §8.1, Kuru v2): the
    /// 30-minute average of the book mid (pool odds before graduation), with no haircut, capped at the
    /// winning payout, and the exact payout once settled. The limiter values deposits and withdrawals
    /// with the same price, so it needs the fair value, not the lending adapters' low one.
    function kuruFeedParams() public pure returns (IOutcomeTokenPriceAdapterFactory.AdapterParams memory) {
        return IOutcomeTokenPriceAdapterFactory.AdapterParams({
            twapWindow: 30 minutes,
            baseHaircutBps: 0,
            closeHaircutBps: 0,
            rampSeconds: 1,
            spreadMultiplierBps: 0,
            maxSpreadHaircutBps: 0,
            blockTimeMs: 400
        });
    }

    /// `.hunchBook`, or `.stacks.<STACK>` when STACK is set.
    function stackPath() public view returns (string memory) {
        string memory stack = vm.envOr("STACK", string(""));
        return bytes(stack).length == 0 ? ".hunchBook" : string.concat(".stacks.", stack);
    }

    // ---- output ----

    function _write(Deployed memory d) internal {
        string memory k = "periphery";
        vm.serializeAddress(k, "autoRedeemer", d.autoRedeemer);
        vm.serializeAddress(k, "conditionalOrders", d.conditionalOrders);
        vm.serializeAddress(k, "referralRegistry", d.referralRegistry);
        vm.serializeAddress(k, "merkleDistributor", d.merkleDistributor);
        vm.serializeAddress(k, "impliedProbabilityOracle", d.impliedProbabilityOracle);
        vm.serializeAddress(k, "priceAdapterFactory", d.priceAdapterFactory);
        vm.serializeAddress(k, "kuruFeedFactory", d.kuruFeedFactory);
        vm.serializeAddress(k, "templateTimelock", d.templateTimelock);
        vm.serializeAddress(k, "timelockProposer", d.timelockProposer);
        vm.serializeUint(k, "timelockDelay", d.timelockDelay);
        vm.serializeAddress(k, "distributorFunder", d.distributorFunder);
        vm.serializeUint(k, "referralDuration", d.referralDuration);
        string memory out = vm.serializeUint(k, "deployBlock", d.deployBlock);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(out, _deploymentPath(), string.concat(stackPath(), ".periphery"));
        } else {
            console2.log("dry run: deployments file not written");
        }
        console2.log(out);
    }

    /// After a broadcast run: reads each contract's creation transaction from forge's broadcast log,
    /// checks it created the address recorded under `<stack>.periphery`, and writes the hashes under
    /// `<stack>.periphery.deployTxs`. Sends nothing.
    function recordTxs() external {
        string memory path = _deploymentPath();
        string memory json = vm.readFile(path);
        string memory periphery = string.concat(stackPath(), ".periphery");
        require(vm.keyExistsJson(json, periphery), "periphery is not deployed on this stack");

        string[8] memory names = [
            "AutoRedeemer",
            "ConditionalOrders",
            "ReferralRegistry",
            "MerkleDistributor",
            "ImpliedProbabilityOracle",
            "OutcomeTokenPriceAdapterFactory",
            "OutcomeTokenPriceAdapterFactory",
            "TemplateTimelock"
        ];
        string[8] memory keys = [
            "autoRedeemer",
            "conditionalOrders",
            "referralRegistry",
            "merkleDistributor",
            "impliedProbabilityOracle",
            "priceAdapterFactory",
            "kuruFeedFactory",
            "templateTimelock"
        ];
        string memory k = "deployTxs";
        string memory out;
        for (uint256 i; i < names.length; ++i) {
            string memory key = string.concat(periphery, ".", keys[i]);
            if (!vm.keyExistsJson(json, key)) continue;
            address recorded = vm.parseJsonAddress(json, key);
            VmSafe.BroadcastTxSummary[] memory all =
                vm.getBroadcasts(names[i], uint64(block.chainid), VmSafe.BroadcastTxType.Create);
            bytes32 hash;
            for (uint256 j; j < all.length; ++j) {
                if (all[j].success && all[j].contractAddress == recorded) hash = all[j].txHash;
            }
            require(hash != bytes32(0), string.concat("broadcast log mismatch: ", keys[i]));
            out = vm.serializeBytes32(k, keys[i], hash);
        }
        vm.writeJson(out, path, string.concat(periphery, ".deployTxs"));
        console2.log(out);
    }

    function _deploymentPath() internal view returns (string memory) {
        string memory network;
        if (block.chainid == TESTNET) network = "monad-testnet";
        else if (block.chainid == MAINNET) network = "monad-mainnet";
        else revert("unknown chain");
        return string.concat(vm.projectRoot(), "/../deployments/", network, ".json");
    }
}
