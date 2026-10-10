// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Graduator} from "../src/core/Graduator.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {HunchRouter} from "../src/core/HunchRouter.sol";
import {IGraduator} from "../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IResolver} from "../src/interfaces/IResolver.sol";
import {IKuruMarginAccount} from "../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruRouter} from "../src/interfaces/external/IKuruRouter.sol";
import {MarketOutcomeResolver} from "../src/resolvers/MarketOutcomeResolver.sol";
import {HunchOrderBookFactory} from "../src/venue/HunchOrderBookFactory.sol";
import {Deploy} from "./Deploy.s.sol";

/// Deploys an extra stack on Hunch Book's own order book next to a network's primary stack, reusing the
/// primary stack's collateral, market implementation and every resolver that is not tied to a factory
/// (templates 1 to 5 and 7), so it costs a fraction of a full deploy (PROTOCOL.md §8.1, "Hunch order
/// book"). New: factory and vault, HunchOrderBookFactory with its HunchMarginAccount and book
/// implementation, the v1 Graduator (creating books itself) and HunchRouter, and the parlay resolver
/// (template 6), which is bound to its factory. The deployer is the guardian and registers templates 1
/// to 7 with one graduation rule (GRADUATION_MIN_POOL / GRADUATION_MIN_STAKERS, see Deploy.s.sol).
/// Writes `.stacks.<STACK>` (default `hunch`) only in a broadcast run.
///
///   cd <checkout with .env> && STACK=hunch GRADUATION_MIN_POOL=100 GRADUATION_MIN_STAKERS=3 \
///     forge script <root>/script/DeployHunchStack.s.sol:DeployHunchStack --root <root> \
///     --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 110
///
/// Testnet only: a mainnet launch has no primary stack to reuse and a multisig guardian, so it uses
/// Deploy.s.sol with VENUE=hunch and the template scripts.
contract DeployHunchStack is Deploy {
    /// Template 6's block-time assumption, as in DeployTemplatesV2.s.sol.
    uint256 internal constant FAST_BLOCK_TIME_MS = 200;

    struct Stack {
        address usdc;
        address marketImplementation;
        address factory;
        address vault;
        address graduator;
        address router;
        address bookFactory;
        address marginAccount;
        address bookImplementation;
        address perplFunding;
        address priceAtTime;
        address chainlinkTouch;
        address perplFundingSpike;
        address priceRange;
        address marketOutcome;
        address snapshot;
        address guardian;
        uint256 deployBlock;
    }

    function run() external override {
        require(block.chainid == TESTNET, "testnet only: use Deploy.s.sol VENUE=hunch on mainnet");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory name = vm.envOr("STACK", string("hunch"));
        string memory path = _deploymentPath();
        string memory j = vm.readFile(path);
        string memory stackKey = string.concat(".stacks.", name);
        require(!vm.keyExistsJson(j, string.concat(stackKey, ".factory")), "already deployed on this stack");

        Stack memory s;
        s.usdc = vm.parseJsonAddress(j, ".hunchBook.usdc");
        s.marketImplementation = vm.parseJsonAddress(j, ".hunchBook.marketImplementation");
        s.perplFunding = vm.parseJsonAddress(j, ".hunchBook.resolvers.perplFunding");
        s.priceAtTime = vm.parseJsonAddress(j, ".hunchBook.resolvers.priceAtTime");
        s.chainlinkTouch = vm.parseJsonAddress(j, ".hunchBook.resolvers.chainlinkTouch");
        s.perplFundingSpike = vm.parseJsonAddress(j, ".hunchBook.resolvers.perplFundingSpike");
        s.priceRange = vm.parseJsonAddress(j, ".hunchBook.resolvers.priceRange");
        s.snapshot = vm.parseJsonAddress(j, ".hunchBook.resolvers.snapshot");
        s.guardian = vm.addr(key);
        s.deployBlock = block.number;

        vm.startBroadcast(key);
        HunchBookFactory factory =
            new HunchBookFactory(s.usdc, s.marketImplementation, s.guardian, s.guardian, betaCaps(), COLLATERAL_CAP);
        s.factory = address(factory);
        s.vault = factory.vault();

        HunchOrderBookFactory venue = new HunchOrderBookFactory(IHunchBookFactory(s.factory));
        s.bookFactory = address(venue);
        s.marginAccount = address(venue.marginAccount());
        s.bookImplementation = venue.implementation();
        s.graduator = address(
            new Graduator(
                IHunchBookFactory(s.factory),
                IKuruRouter(s.bookFactory),
                IKuruMarginAccount(s.marginAccount),
                s.usdc,
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
            )
        );
        factory.setGraduator(s.graduator);
        s.router = address(new HunchRouter(IHunchBookFactory(s.factory)));
        s.marketOutcome = address(new MarketOutcomeResolver(IHunchBookFactory(s.factory), FAST_BLOCK_TIME_MS));

        _register(factory, s);
        vm.stopBroadcast();

        _writeStack(path, stackKey, s);
    }

    function _register(HunchBookFactory factory, Stack memory s) internal {
        factory.addTemplate(1, IResolver(s.perplFunding), graduationRule());
        factory.addTemplate(2, IResolver(s.priceAtTime), graduationRule());
        factory.addTemplate(3, IResolver(s.chainlinkTouch), graduationRule());
        factory.addTemplate(4, IResolver(s.perplFundingSpike), graduationRule());
        factory.addTemplate(5, IResolver(s.priceRange), graduationRule());
        factory.addTemplate(6, IResolver(s.marketOutcome), graduationRule());
        factory.addTemplate(7, IResolver(s.snapshot), graduationRule());
    }

    function _writeStack(string memory path, string memory stackKey, Stack memory s) internal {
        string memory r = "hunchResolvers";
        vm.serializeAddress(r, "chainlinkTouch", s.chainlinkTouch);
        vm.serializeAddress(r, "marketOutcome", s.marketOutcome);
        vm.serializeAddress(r, "perplFunding", s.perplFunding);
        vm.serializeAddress(r, "perplFundingSpike", s.perplFundingSpike);
        vm.serializeAddress(r, "priceAtTime", s.priceAtTime);
        vm.serializeAddress(r, "priceRange", s.priceRange);
        string memory resolvers = vm.serializeAddress(r, "snapshot", s.snapshot);

        string memory v = "hunchVenue";
        vm.serializeString(v, "kind", "hunch");
        vm.serializeAddress(v, "bookFactory", s.bookFactory);
        vm.serializeAddress(v, "marginAccount", s.marginAccount);
        string memory venue = vm.serializeAddress(v, "bookImplementation", s.bookImplementation);

        string memory k = "hunchStack";
        vm.serializeAddress(k, "usdc", s.usdc);
        vm.serializeAddress(k, "marketImplementation", s.marketImplementation);
        vm.serializeAddress(k, "factory", s.factory);
        vm.serializeAddress(k, "vault", s.vault);
        vm.serializeAddress(k, "graduator", s.graduator);
        vm.serializeAddress(k, "router", s.router);
        vm.serializeUint(k, "kuruVersion", 1);
        vm.serializeString(k, "venue", venue);
        vm.serializeString(k, "resolvers", resolvers);
        vm.serializeAddress(k, "guardian", s.guardian);
        vm.serializeAddress(k, "feeRecipient", s.guardian);
        string memory out = vm.serializeUint(k, "deployBlock", s.deployBlock);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) vm.writeJson(out, path, stackKey);
        else console2.log("dry run: deployments file not written");
        console2.log(out);
    }
}
