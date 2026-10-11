// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {GraduationRuleEnv} from "./GraduationRuleEnv.sol";
import {Graduator} from "../src/core/Graduator.sol";
import {GraduatorV2} from "../src/core/GraduatorV2.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../src/core/HunchRouter.sol";
import {HunchRouterV2} from "../src/core/HunchRouterV2.sol";
import {Market} from "../src/core/Market.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {PerplFundingResolver} from "../src/resolvers/PerplFundingResolver.sol";
import {PriceAtTimeResolver} from "../src/resolvers/PriceAtTimeResolver.sol";
import {IGraduator} from "../src/interfaces/IGraduator.sol";
import {IGraduatorV2} from "../src/interfaces/IGraduatorV2.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../src/interfaces/IResolver.sol";
import {MarketCaps} from "../src/interfaces/IHunchBookTypes.sol";
import {IKuruMarginAccount} from "../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruRouter} from "../src/interfaces/external/IKuruRouter.sol";
import {IKuruAccountCore, IKuruSpotRouter} from "../src/interfaces/external/IKuruV2.sol";
import {IPerplExchange} from "../src/interfaces/external/IPerplExchange.sol";
import {IPyth} from "../src/interfaces/external/IPyth.sol";
import {HunchOrderBookFactory} from "../src/venue/HunchOrderBookFactory.sol";

/// Deploys Hunch Book to a Monad network and writes every address into deployments/<network>.json,
/// the only address source every reader uses. A dry run (no --broadcast) writes nothing.
///
///   DEPLOYER_PRIVATE_KEY=... forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast \
///     --gas-estimate-multiplier 110
///
/// The key is read from the environment, never passed on the command line. Without DEPLOYER_PRIVATE_KEY
/// the script deploys from forge's own wallet flags (`--account <name>`, `--ledger`, `--interactive`),
/// and a dry run needs only `--sender <deployer address>`.
///
/// Testnet: collateral is TestUSDC (Kuru's testnet USDC cannot be minted) and the deployer is the
/// guardian, so it registers the templates here. Mainnet: collateral is Circle USDC and GUARDIAN must be
/// set to a separate address (a multisig, or at least a key that is not the deployer's), which then adds
/// the templates itself (GuardianBatch.s.sol). The script stops when GUARDIAN is unset on mainnet.
///
/// Kuru version (PROTOCOL.md §8.1). KURU_VERSION=1 (the default on every network): the Graduator creates
/// books itself where Kuru v1 allows it (testnet) or verifies and registers the books Kuru creates
/// (mainnet, where Kuru v1's Router.deployProxy is owner-only). KURU_VERSION=2: GraduatorV2 and
/// HunchRouterV2 against `.external.kuruV2`; Kuru governance creates every book.
///
/// Stacks. Without STACK the deployment is the network's primary stack (`.hunchBook`). STACK=<name>
/// deploys an extra stack under `.stacks.<name>` (testnet: STACK=kuruV2 next to the v1 stack); it reuses
/// the primary stack's collateral token, so one test USDC works on both.
///
/// Mainnet before Kuru v2 is live: WIRE_KURU=0 deploys everything except the graduator and router;
/// pools work and cannot graduate until script/WireKuruV2.s.sol wires them (the factory's one-time
/// setGraduator, by the same deployer key).
///
/// Venue (PROTOCOL.md §8.1). VENUE=kuru (default) trades on Kuru as above. VENUE=hunch deploys Hunch
/// Book's own order book (HunchOrderBookFactory, its HunchMarginAccount and the book implementation)
/// and wires the v1 Graduator and HunchRouter to it: books are created at graduation on any network,
/// with no third party. It implies KURU_VERSION=1 (the books speak Kuru v1's interface) and writes
/// `<stack>.venue`.
///
/// Graduation rule (PROTOCOL.md §5.3, §12): GRADUATION_MIN_POOL (USDC, whole units) and
/// GRADUATION_MIN_STAKERS override the v0 values (500 USDC, 10 stakers) for templates 1 and 2; the
/// other template scripts and GuardianBatch.s.sol copy template 1's rule (GraduationRuleEnv.sol).
///
/// Env: DEPLOYER_PRIVATE_KEY (optional, see above); GUARDIAN (required on mainnet, elsewhere default the
/// deployer); FEE_RECIPIENT (default the deployer, who can hand it on with setFeeRecipient);
/// KURU_VERSION; STACK; WIRE_KURU (default 1); KURU_TAKER_FEE_PPS / KURU_MAKER_FEE_PPS (the fees asked
/// of Kuru for v2 books; default 7000 / 4000, Kuru's testnet defaults).
contract Deploy is GraduationRuleEnv {
    uint256 internal constant TESTNET = 10_143;
    uint256 internal constant MAINNET = 143;

    uint32 internal constant TEMPLATE_PERPL_FUNDING = 1;
    uint32 internal constant TEMPLATE_PRICE_AT_TIME = 2;

    /// Most USDC the vault may hold across all markets during the beta (PROTOCOL.md §10.3).
    uint256 public constant COLLATERAL_CAP = 50_000e6;

    /// Conservative milliseconds per Monad block, used only for S-1 settlement deadlines.
    uint256 internal constant BLOCK_TIME_MS = 1000;

    /// What to deploy; `options()` reads it from the environment (KURU_VERSION, STACK, WIRE_KURU).
    struct Options {
        uint8 kuruVersion;
        /// "" for the primary stack, otherwise the name under `.stacks`.
        string stack;
        /// False deploys no graduator and router (mainnet before Kuru v2 exists).
        bool wireKuru;
        /// True: Hunch Book's own order book instead of Kuru (VENUE=hunch).
        bool hunchVenue;
    }

    struct Deployed {
        address usdc;
        address marketImplementation;
        address factory;
        address vault;
        address perplFunding;
        address priceAtTime;
        address graduator;
        address router;
        address guardian;
        address feeRecipient;
        uint256 deployBlock;
        uint8 kuruVersion;
        /// Hunch's own venue (VENUE=hunch); zero otherwise.
        address bookFactory;
        address marginAccount;
        address bookImplementation;
    }

    string internal json;
    uint256 internal pk;
    /// The deployment goes under `.stacks` (testnet: reuse the primary stack's test USDC).
    bool internal extraStack;

    function run() external virtual {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerOf(key);
        // Mainnet never falls back to the deployer as guardian: the address must be given on purpose.
        require(
            block.chainid != MAINNET || vm.envExists("GUARDIAN"),
            "GUARDIAN is not set: mainnet needs the separate guardian address"
        );
        Options memory o = options();
        Deployed memory d = deployWith(key, vm.envOr("GUARDIAN", deployer), vm.envOr("FEE_RECIPIENT", deployer), o);
        _write(_deploymentPath(), stackPathOf(o.stack), d);
    }

    /// The deploying address: the key's, or (key 0) the wallet forge broadcasts from (`--sender`,
    /// `--account`, `--ledger`, `--interactive`). Refuses forge's default sender, which has no wallet.
    function deployerOf(uint256 key) public view returns (address deployer) {
        deployer = key != 0 ? vm.addr(key) : msg.sender;
        require(deployer != DEFAULT_SENDER, "no deployer: set DEPLOYER_PRIVATE_KEY or pass --sender or a wallet flag");
    }

    /// The options from the environment: KURU_VERSION (default 1), STACK (default the primary stack),
    /// WIRE_KURU (default 1) and VENUE (default kuru).
    function options() public view returns (Options memory o) {
        // forge-lint: disable-next-line(unsafe-typecast)
        o.kuruVersion = uint8(vm.envOr("KURU_VERSION", uint256(1)));
        o.stack = vm.envOr("STACK", string(""));
        o.wireKuru = vm.envOr("WIRE_KURU", uint256(1)) != 0;
        string memory venue = vm.envOr("VENUE", string("kuru"));
        o.hunchVenue = keccak256(bytes(venue)) == keccak256("hunch");
        require(o.hunchVenue || keccak256(bytes(venue)) == keccak256("kuru"), "VENUE must be kuru or hunch");
        if (o.hunchVenue) o.kuruVersion = 1;
    }

    /// Deploys everything from `key` and returns the addresses without writing them anywhere.
    /// `run` calls it; the mainnet rehearsal fork test calls it directly.
    function deploy(uint256 key, address guardian, address feeRecipient) public returns (Deployed memory) {
        return deployWith(key, guardian, feeRecipient, options());
    }

    /// `deploy` with explicit options (the fork tests pass them, so parallel tests share no environment).
    function deployWith(uint256 key, address guardian, address feeRecipient, Options memory o)
        public
        returns (Deployed memory d)
    {
        json = vm.readFile(_deploymentPath());
        require(
            !vm.keyExistsJson(json, string.concat(stackPathOf(o.stack), ".factory")), "already deployed on this stack"
        );
        extraStack = bytes(o.stack).length != 0;

        pk = key;
        address deployer = deployerOf(pk);
        d.guardian = guardian;
        d.feeRecipient = feeRecipient;
        d.kuruVersion = o.kuruVersion;
        require(d.kuruVersion == 1 || d.kuruVersion == 2, "KURU_VERSION must be 1 or 2");
        require(!o.hunchVenue || d.kuruVersion == 1, "VENUE=hunch books use the Kuru v1 interface");
        if (block.chainid == MAINNET) {
            require(d.guardian != deployer, "mainnet guardian must be a separate multisig, not the deployer");
            require(d.feeRecipient != address(0), "fee recipient required");
        }
        d.deployBlock = block.number;

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        _deployCore(d);
        _deployResolvers(d);
        if (o.hunchVenue) _deployHunchVenue(d);
        else if (o.wireKuru) _deployTrading(d);
        if (d.guardian == deployer) _addTemplates(d);
        vm.stopBroadcast();
    }

    /// `.hunchBook` for "", otherwise `.stacks.<stack>`.
    function stackPathOf(string memory stack) public pure returns (string memory) {
        return bytes(stack).length == 0 ? ".hunchBook" : string.concat(".stacks.", stack);
    }

    /// The stack path for STACK in the environment.
    function stackPath() public view returns (string memory) {
        return stackPathOf(vm.envOr("STACK", string("")));
    }

    /// The v2 book parameters Hunch Book asks Kuru for (PROTOCOL.md §8.1, Kuru v2).
    function requestedV2() public view returns (IGraduatorV2.RequestedParams memory) {
        return IGraduatorV2.RequestedParams({
            sizePrecision: 1e6,
            pricePrecision: 1e6,
            tickSize: 1000,
            passiveSpreadTicks: 10,
            minQuoteNotional: 1e6,
            takerFeePps: vm.envOr("KURU_TAKER_FEE_PPS", uint256(7000)),
            makerFeePps: vm.envOr("KURU_MAKER_FEE_PPS", uint256(4000))
        });
    }

    /// What a Kuru-created v2 book may differ in: tick up to 0.01 USDC, minimum order up to 10 USDC,
    /// taker fee up to 0.3% (Kuru's own cap is 1%).
    function limitsV2() public pure returns (IGraduatorV2.Limits memory) {
        return IGraduatorV2.Limits({maxTickSize: 10_000, maxMinQuoteNotional: 10e6, maxTakerFeePps: 30_000});
    }

    // ---- steps ----

    function _deployCore(Deployed memory d) internal {
        if (block.chainid != TESTNET) d.usdc = vm.parseJsonAddress(json, ".external.usdc");
        else if (extraStack) d.usdc = vm.parseJsonAddress(json, ".hunchBook.usdc");
        else d.usdc = address(new TestUSDC());
        d.marketImplementation = address(new Market());
        HunchBookFactory factory = new HunchBookFactory(
            d.usdc, d.marketImplementation, d.guardian, d.feeRecipient, betaCaps(), COLLATERAL_CAP
        );
        d.factory = address(factory);
        d.vault = factory.vault();
    }

    function _deployResolvers(Deployed memory d) internal {
        d.perplFunding = address(
            new PerplFundingResolver(
                IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange")), BLOCK_TIME_MS
            )
        );

        // Chainlink wherever Monad has a feed; Pyth only for assets without one.
        address[] memory feeds;
        bytes32[] memory pythIds;
        string[] memory labels;
        address pyth;
        if (block.chainid == TESTNET) {
            feeds = new address[](2);
            feeds[0] = vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']");
            feeds[1] = vm.parseJsonAddress(json, ".external.chainlink['ETH/USD']");
            pyth = vm.parseJsonAddress(json, ".external.pyth.contract");
            pythIds = new bytes32[](2);
            labels = new string[](2);
            pythIds[0] = vm.parseJsonBytes32(json, ".external.pyth.ids['SOL/USD']");
            labels[0] = "SOL/USD";
            pythIds[1] = vm.parseJsonBytes32(json, ".external.pyth.ids['MON/USD']");
            labels[1] = "MON/USD";
        } else {
            feeds = new address[](4);
            feeds[0] = vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']");
            feeds[1] = vm.parseJsonAddress(json, ".external.chainlink['ETH/USD']");
            feeds[2] = vm.parseJsonAddress(json, ".external.chainlink['MON/USD']");
            feeds[3] = vm.parseJsonAddress(json, ".external.chainlink['SOL/USD']");
            pythIds = new bytes32[](0);
            labels = new string[](0);
        }
        d.priceAtTime = address(new PriceAtTimeResolver(feeds, IPyth(pyth), pythIds, labels));
    }

    function _deployTrading(Deployed memory d) internal {
        if (d.kuruVersion == 2) {
            (d.graduator, d.router) = deployKuruV2(d.factory, d.usdc);
            HunchBookFactory(d.factory).setGraduator(d.graduator);
            return;
        }
        Graduator graduator = new Graduator(
            IHunchBookFactory(d.factory),
            IKuruRouter(vm.parseJsonAddress(json, ".external.kuru.router")),
            IKuruMarginAccount(vm.parseJsonAddress(json, ".external.kuru.marginAccount")),
            d.usdc,
            block.chainid == TESTNET,
            // PROTOCOL.md §8.1. Fees 0/0 match Kuru's own mainnet markets.
            IGraduator.BookParams({
                sizePrecision: 1e6,
                pricePrecision: 1e6,
                tickSize: 1000,
                minSize: 1e6,
                takerFeeBps: 0,
                makerFeeBps: 0,
                kuruAmmSpread: 30
            })
        );
        d.graduator = address(graduator);
        HunchBookFactory(d.factory).setGraduator(d.graduator);
        d.router = address(new HunchRouter(IHunchBookFactory(d.factory)));
    }

    /// Hunch Book's own order book, with the v1 Graduator (creating books on every network) and the v1
    /// HunchRouter on it (PROTOCOL.md §8.1, "Hunch order book"). Same book parameters as on Kuru v1.
    function _deployHunchVenue(Deployed memory d) internal {
        HunchOrderBookFactory venue = new HunchOrderBookFactory(IHunchBookFactory(d.factory));
        d.bookFactory = address(venue);
        d.marginAccount = address(venue.marginAccount());
        d.bookImplementation = venue.implementation();
        Graduator graduator = new Graduator(
            IHunchBookFactory(d.factory),
            IKuruRouter(d.bookFactory),
            IKuruMarginAccount(d.marginAccount),
            d.usdc,
            true,
            IGraduator.BookParams({
                sizePrecision: 1e6,
                pricePrecision: 1e6,
                tickSize: 1000,
                minSize: 1e6,
                takerFeeBps: 0,
                makerFeeBps: 0,
                kuruAmmSpread: 30
            })
        );
        d.graduator = address(graduator);
        HunchBookFactory(d.factory).setGraduator(d.graduator);
        d.router = address(new HunchRouter(IHunchBookFactory(d.factory)));
    }

    /// GraduatorV2 and HunchRouterV2 for `factory`, against Kuru's v2 addresses in the deployment file.
    /// Inside a broadcast; WireKuruV2.s.sol reuses it.
    function deployKuruV2(address factory, address usdc) public returns (address graduator, address router) {
        string memory j = vm.readFile(_deploymentPath());
        require(
            vm.keyExistsJson(j, ".external.kuruV2.spotRouter"),
            "Kuru v2 addresses are not in the deployments file: deploy with WIRE_KURU=0, wire later (WireKuruV2.s.sol)"
        );
        IKuruSpotRouter spotRouter = IKuruSpotRouter(vm.parseJsonAddress(j, ".external.kuruV2.spotRouter"));
        IKuruAccountCore accountCore = IKuruAccountCore(vm.parseJsonAddress(j, ".external.kuruV2.accountCore"));
        graduator = address(
            new GraduatorV2(IHunchBookFactory(factory), spotRouter, accountCore, usdc, requestedV2(), limitsV2())
        );
        router = address(new HunchRouterV2(IHunchBookFactory(factory), accountCore));
    }

    function _addTemplates(Deployed memory d) internal {
        HunchBookFactory factory = HunchBookFactory(d.factory);
        factory.addTemplate(TEMPLATE_PERPL_FUNDING, IResolver(d.perplFunding), graduationRule());
        factory.addTemplate(TEMPLATE_PRICE_AT_TIME, IResolver(d.priceAtTime), graduationRule());
    }

    // ---- parameters (PROTOCOL.md §10.3, §12) ----

    function betaCaps() public pure returns (MarketCaps memory) {
        return MarketCaps({poolCap: 5000e6, walletCap: 1000e6, minStake: 1e6, creatorMinStake: 5e6});
    }

    // ---- output ----

    function _write(string memory path, string memory stack, Deployed memory d) internal {
        string memory r = "resolvers";
        vm.serializeAddress(r, "perplFunding", d.perplFunding);
        string memory resolvers = vm.serializeAddress(r, "priceAtTime", d.priceAtTime);

        string memory k = "hunchBook";
        vm.serializeAddress(k, "usdc", d.usdc);
        vm.serializeAddress(k, "marketImplementation", d.marketImplementation);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "vault", d.vault);
        if (d.graduator != address(0)) {
            vm.serializeAddress(k, "graduator", d.graduator);
            vm.serializeAddress(k, "router", d.router);
        }
        vm.serializeUint(k, "kuruVersion", d.kuruVersion);
        if (d.bookFactory != address(0)) {
            string memory v = "venue";
            vm.serializeString(v, "kind", "hunch");
            vm.serializeAddress(v, "bookFactory", d.bookFactory);
            vm.serializeAddress(v, "marginAccount", d.marginAccount);
            string memory venue = vm.serializeAddress(v, "bookImplementation", d.bookImplementation);
            vm.serializeString(k, "venue", venue);
        }
        vm.serializeString(k, "resolvers", resolvers);
        vm.serializeAddress(k, "guardian", d.guardian);
        vm.serializeAddress(k, "feeRecipient", d.feeRecipient);
        string memory out = vm.serializeUint(k, "deployBlock", d.deployBlock);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) vm.writeJson(out, path, stack);
        else console2.log("dry run: deployments file not written");
        console2.log(out);
    }

    // ---- deployment record ----

    /// After the broadcast run has landed: reads each deploy transaction from forge's broadcast log,
    /// checks it created the address in the deployments file, and writes the hashes under
    /// `<stack>.deployTxs` (entries other scripts wrote there are kept). Sends nothing.
    ///
    ///   forge script script/Deploy.s.sol --sig "record()" --rpc-url <rpc>
    function record() external {
        string memory path = _deploymentPath();
        string memory j = vm.readFile(path);
        string memory stack = stackPath();
        require(vm.keyExistsJson(j, string.concat(stack, ".factory")), "nothing deployed on this stack");
        string memory txs = string.concat(stack, ".deployTxs");
        string memory k = "deployTxs";
        string memory out;
        if (vm.keyExistsJson(j, txs)) {
            string[] memory existing = vm.parseJsonKeys(j, txs);
            for (uint256 i; i < existing.length; ++i) {
                out = vm.serializeBytes32(k, existing[i], vm.parseJsonBytes32(j, string.concat(txs, ".", existing[i])));
            }
        }
        out = _recordCreate(j, stack, k, "Market", ".marketImplementation", "marketImplementation", out);
        out = _recordCreate(j, stack, k, "HunchBookFactory", ".factory", "factory", out);
        out = _recordCreate(j, stack, k, "PerplFundingResolver", ".resolvers.perplFunding", "perplFunding", out);
        out = _recordCreate(j, stack, k, "PriceAtTimeResolver", ".resolvers.priceAtTime", "priceAtTime", out);
        out = _recordCreate(j, stack, k, "Graduator", ".graduator", "graduator", out);
        out = _recordCreate(j, stack, k, "GraduatorV2", ".graduator", "graduator", out);
        out = _recordCreate(j, stack, k, "HunchRouter", ".router", "router", out);
        out = _recordCreate(j, stack, k, "HunchRouterV2", ".router", "router", out);
        out = _recordCreate(j, stack, k, "HunchOrderBookFactory", ".venue.bookFactory", "bookFactory", out);
        if (block.chainid == TESTNET && !extraStackPath(stack)) {
            out = _recordCreate(j, stack, k, "TestUSDC", ".usdc", "usdc", out);
        }
        out = _recordSetGraduator(j, stack, k, out);
        require(bytes(out).length != 0, "no deploy transaction found in the broadcast log");
        vm.writeJson(out, path, txs);
        console2.log(out);
    }

    /// True for a path under `.stacks`.
    function extraStackPath(string memory stack) public pure returns (bool) {
        return keccak256(bytes(stack)) != keccak256(bytes(".hunchBook"));
    }

    /// Adds `txName` = the logged CREATE of `contractName` that made the address at `stack + suffix`.
    /// Skips names this deployment did not create (another contract type at that key, or no key).
    function _recordCreate(
        string memory j,
        string memory stack,
        string memory k,
        string memory contractName,
        string memory suffix,
        string memory txName,
        string memory out
    ) internal returns (string memory) {
        string memory key = string.concat(stack, suffix);
        if (!vm.keyExistsJson(j, key)) return out;
        address recorded = vm.parseJsonAddress(j, key);
        VmSafe.BroadcastTxSummary[] memory all;
        try vm.getBroadcasts(contractName, uint64(block.chainid), VmSafe.BroadcastTxType.Create) returns (
            VmSafe.BroadcastTxSummary[] memory found
        ) {
            all = found;
        } catch {
            return out;
        }
        for (uint256 i; i < all.length; ++i) {
            if (all[i].success && all[i].contractAddress == recorded) {
                console2.log(txName, recorded);
                return vm.serializeBytes32(k, txName, all[i].txHash);
            }
        }
        return out;
    }

    /// Adds `setGraduator`: the first logged call to the factory after the graduator was created.
    function _recordSetGraduator(string memory j, string memory stack, string memory k, string memory out)
        internal
        returns (string memory)
    {
        if (!vm.keyExistsJson(j, string.concat(stack, ".graduator"))) return out;
        address factory = vm.parseJsonAddress(j, string.concat(stack, ".factory"));
        VmSafe.BroadcastTxSummary[] memory calls;
        try vm.getBroadcasts("HunchBookFactory", uint64(block.chainid), VmSafe.BroadcastTxType.Call) returns (
            VmSafe.BroadcastTxSummary[] memory found
        ) {
            calls = found;
        } catch {
            return out;
        }
        uint256 best = type(uint256).max;
        for (uint256 i; i < calls.length; ++i) {
            if (!calls[i].success || calls[i].contractAddress != factory) continue;
            if (best == type(uint256).max || calls[i].blockNumber < calls[best].blockNumber) best = i;
        }
        if (best == type(uint256).max) return out;
        return vm.serializeBytes32(k, "setGraduator", calls[best].txHash);
    }

    function _deploymentPath() internal view virtual returns (string memory) {
        string memory network;
        if (block.chainid == TESTNET) network = "monad-testnet";
        else if (block.chainid == MAINNET) network = "monad-mainnet";
        else revert("unknown chain");
        return string.concat(vm.projectRoot(), "/../deployments/", network, ".json");
    }
}
