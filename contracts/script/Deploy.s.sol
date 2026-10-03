// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Graduator} from "../src/core/Graduator.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../src/core/HunchRouter.sol";
import {Market} from "../src/core/Market.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {PerplFundingResolver} from "../src/resolvers/PerplFundingResolver.sol";
import {PriceAtTimeResolver} from "../src/resolvers/PriceAtTimeResolver.sol";
import {IGraduator} from "../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../src/interfaces/IResolver.sol";
import {GraduationRule, MarketCaps} from "../src/interfaces/IHunchBookTypes.sol";
import {IKuruMarginAccount} from "../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruRouter} from "../src/interfaces/external/IKuruRouter.sol";
import {IPerplExchange} from "../src/interfaces/external/IPerplExchange.sol";
import {IPyth} from "../src/interfaces/external/IPyth.sol";

/// Deploys Hunch Book to a Monad network and writes every address into deployments/<network>.json,
/// the only address source every reader uses. A dry run (no --broadcast) writes nothing.
///
///   DEPLOYER_PRIVATE_KEY=... forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast \
///     --gas-estimate-multiplier 110
///
/// The key is read from the environment, never passed on the command line.
///
/// Testnet: collateral is TestUSDC (Kuru's testnet USDC cannot be minted), the Graduator creates
/// Kuru books itself, and the deployer is the guardian, so it registers the templates here.
/// Mainnet: collateral is Circle USDC, Kuru creates each book (the Graduator only verifies and
/// registers), and GUARDIAN must be a separate multisig, which then adds the templates itself.
///
/// Env: DEPLOYER_PRIVATE_KEY; GUARDIAN and FEE_RECIPIENT (default: the deployer, testnet only).
contract Deploy is Script {
    uint256 internal constant TESTNET = 10_143;
    uint256 internal constant MAINNET = 143;

    uint32 internal constant TEMPLATE_PERPL_FUNDING = 1;
    uint32 internal constant TEMPLATE_PRICE_AT_TIME = 2;

    /// Conservative milliseconds per Monad block, used only for S-1 settlement deadlines.
    uint256 internal constant BLOCK_TIME_MS = 1000;

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
    }

    string internal json;
    uint256 internal pk;

    function run() external {
        string memory path = _deploymentPath();
        json = vm.readFile(path);
        require(!vm.keyExistsJson(json, ".hunchBook.factory"), "already deployed on this network");

        pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        Deployed memory d;
        d.guardian = vm.envOr("GUARDIAN", deployer);
        d.feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        if (block.chainid == MAINNET) {
            require(d.guardian != deployer, "mainnet guardian must be a separate multisig, not the deployer");
        }
        d.deployBlock = block.number;

        vm.startBroadcast(pk);
        _deployCore(d);
        _deployResolvers(d);
        _deployTrading(d);
        if (d.guardian == deployer) _addTemplates(d);
        vm.stopBroadcast();

        _write(path, d);
    }

    // ---- steps ----

    function _deployCore(Deployed memory d) internal {
        d.usdc = block.chainid == TESTNET ? address(new TestUSDC()) : vm.parseJsonAddress(json, ".external.usdc");
        d.marketImplementation = address(new Market());
        HunchBookFactory factory =
            new HunchBookFactory(d.usdc, d.marketImplementation, d.guardian, d.feeRecipient, _caps(), 50_000e6);
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

    function _addTemplates(Deployed memory d) internal {
        HunchBookFactory factory = HunchBookFactory(d.factory);
        factory.addTemplate(TEMPLATE_PERPL_FUNDING, IResolver(d.perplFunding), _rule());
        factory.addTemplate(TEMPLATE_PRICE_AT_TIME, IResolver(d.priceAtTime), _rule());
    }

    // ---- parameters (PROTOCOL.md §10.3, §12) ----

    function _caps() internal pure returns (MarketCaps memory) {
        return MarketCaps({poolCap: 5000e6, walletCap: 1000e6, minStake: 1e6, creatorMinStake: 5e6});
    }

    function _rule() internal pure returns (GraduationRule memory) {
        return GraduationRule({minPool: 500e6, minStakers: 10, minChanceBps: 300, maxChanceBps: 9700});
    }

    // ---- output ----

    function _write(string memory path, Deployed memory d) internal {
        string memory r = "resolvers";
        vm.serializeAddress(r, "perplFunding", d.perplFunding);
        string memory resolvers = vm.serializeAddress(r, "priceAtTime", d.priceAtTime);

        string memory k = "hunchBook";
        vm.serializeAddress(k, "usdc", d.usdc);
        vm.serializeAddress(k, "marketImplementation", d.marketImplementation);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "vault", d.vault);
        vm.serializeAddress(k, "graduator", d.graduator);
        vm.serializeAddress(k, "router", d.router);
        vm.serializeString(k, "resolvers", resolvers);
        vm.serializeAddress(k, "guardian", d.guardian);
        vm.serializeAddress(k, "feeRecipient", d.feeRecipient);
        string memory out = vm.serializeUint(k, "deployBlock", d.deployBlock);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) vm.writeJson(out, path, ".hunchBook");
        else console2.log("dry run: deployments file not written");
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
