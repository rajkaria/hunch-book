// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {Market} from "../src/core/Market.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {Side} from "../src/interfaces/IHunchBookTypes.sol";
import {PerplFundingParams} from "../src/interfaces/ITemplates.sol";
import {IPerplExchange} from "../src/interfaces/external/IPerplExchange.sol";
import {IImpliedProbabilityOracle} from "../src/periphery/interfaces/IImpliedProbabilityOracle.sol";
import {IOutcomeTokenPriceAdapterFactory} from "../src/periphery/interfaces/IOutcomeTokenPriceAdapterFactory.sol";

/// Testnet only. Creates a market (a Perpl funding market, template 1, unless TEMPLATE and PARAMS name
/// another) and fills its pool from Hunch Book's
/// own wallets so it meets the graduation rule, then graduates it (on a Hunch-venue stack the
/// Graduator creates the book in that same transaction) and pushes every staker's tokens. This
/// activity is ours and is labelled as ours wherever it is counted: the creator is the deployer and
/// the stakers are addresses derived from the deployer key (label "hunch-book testnet seed"), so
/// anyone can see they are one party.
///
///   DEPLOYER_PRIVATE_KEY=... STACK=hunch PERP_ID=64 THRESHOLD=0 forge script script/SeedTestnetMarket.s.sol \
///     --rpc-url $MONAD_TESTNET_RPC --broadcast --slow --gas-estimate-multiplier 110
///
/// Any template: TEMPLATE=<id> PARAMS=<abi-encoded params, 0x...> (the resolver validates them in
/// createMarket). Template 1 builds its params from the variables below when PARAMS is unset.
///
/// Env: STACK (default the primary stack), PERP_ID (default 64, MON), THRESHOLD (raw Perpl units,
/// may be negative; default 1500; 0 asks "will longs pay shorts on net"), LOCK_IN_BLOCKS (default
/// 200,000, about 17 hours), INTERVALS (default 24 funding intervals in the window), CREATOR_STAKE (USDC,
/// default 50, on YES), YES_STAKERS / NO_STAKERS (default 6 / 4) and YES_EACH / NO_EACH (USDC, default
/// 60 / 70), GRADUATE (default true).
///
/// Kuru v2 stacks (`STACK=kuruV2`): graduation needs a book only Kuru can create, so run with
/// GRADUATE=false. The pool is filled to the rule and left open; the script also creates the market's
/// YES and NO feeds for Kuru's withdrawal limiter and pokes the oracle, so the feeds have history before
/// Kuru sets the tokens up. Once Kuru deploys the book, the keeper registers it and graduates the market.
contract SeedTestnetMarket is Script {
    uint32 internal constant TEMPLATE_PERPL_FUNDING = 1;

    function run() external {
        require(block.chainid == 10_143, "testnet only");
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        string memory stack = vm.envOr("STACK", string(""));
        string memory path = bytes(stack).length == 0 ? ".hunchBook" : string.concat(".stacks.", stack);
        HunchBookFactory factory = HunchBookFactory(vm.parseJsonAddress(json, string.concat(path, ".factory")));
        TestUSDC usdc = TestUSDC(vm.parseJsonAddress(json, string.concat(path, ".usdc")));
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint32 templateId = uint32(vm.envOr("TEMPLATE", uint256(TEMPLATE_PERPL_FUNDING)));
        bytes memory params = vm.envOr("PARAMS", bytes(""));
        if (params.length == 0) {
            require(templateId == TEMPLATE_PERPL_FUNDING, "PARAMS is required for this template");
            params = _perplFundingParams(json);
        }

        uint256 yesStakers = vm.envOr("YES_STAKERS", uint256(6));
        uint256 n = 1 + yesStakers + vm.envOr("NO_STAKERS", uint256(4));
        address[] memory stakers = new address[](n);
        stakers[0] = vm.addr(pk);
        for (uint256 i = 1; i < n; ++i) {
            stakers[i] = vm.addr(uint256(keccak256(abi.encode("hunch-book testnet seed", pk, i))) % (2 ** 255));
        }
        uint256 yesEach = vm.envOr("YES_EACH", uint256(60)) * 1e6;
        uint256 noEach = vm.envOr("NO_EACH", uint256(70)) * 1e6;
        uint256 creatorStake = vm.envOr("CREATOR_STAKE", uint256(50)) * 1e6;

        vm.startBroadcast(pk);
        usdc.mint(stakers[0], creatorStake + yesStakers * yesEach + (n - 1 - yesStakers) * noEach);
        usdc.approve(factory.vault(), type(uint256).max);
        Market m = Market(payable(factory.createMarket(templateId, params, Side.Yes, creatorStake)));
        for (uint256 i = 1; i < n; ++i) {
            m.stakeFor(stakers[i], i <= yesStakers ? Side.Yes : Side.No, i <= yesStakers ? yesEach : noEach);
        }
        if (vm.envOr("GRADUATE", true)) {
            m.graduate();
            m.claimTokensFor(stakers);
        }
        vm.stopBroadcast();
        _finish(pk, m, params);
    }

    function _finish(uint256 pk, Market m, bytes memory params) internal {
        _createKuruFeeds(pk, m);
        console2.log("market", address(m));
        if (vm.envOr("GRADUATE", true)) console2.log("book", m.book());
        console2.log(m.resolver().describe(params));
    }

    /// On a stack with a Kuru feed factory (Kuru v2): the market's YES and NO limiter feeds and a first
    /// oracle observation, as GoldenPath.s.sol does.
    function _createKuruFeeds(uint256 pk, Market m) internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        string memory stack = vm.envOr("STACK", string(""));
        string memory path = bytes(stack).length == 0 ? ".hunchBook" : string.concat(".stacks.", stack);
        string memory feedsKey = string.concat(path, ".periphery.kuruFeedFactory");
        if (!vm.keyExistsJson(json, feedsKey)) return;
        IOutcomeTokenPriceAdapterFactory feeds = IOutcomeTokenPriceAdapterFactory(vm.parseJsonAddress(json, feedsKey));
        IImpliedProbabilityOracle oracle = IImpliedProbabilityOracle(
            vm.parseJsonAddress(json, string.concat(path, ".periphery.impliedProbabilityOracle"))
        );
        vm.startBroadcast(pk);
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        address noFeed = feeds.createAdapter(address(m), Side.No);
        oracle.poke(address(m));
        vm.stopBroadcast();
        (address yes, address no) = m.tokens();
        console2.log("YES token", yes);
        console2.log("YES feed (Kuru limiter)", yesFeed);
        console2.log("NO token", no);
        console2.log("NO feed (Kuru limiter)", noFeed);
    }

    function _perplFundingParams(string memory json) internal view returns (bytes memory) {
        IPerplExchange perpl = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));
        uint256 perpId = vm.envOr("PERP_ID", uint256(64));
        PerplFundingParams memory p;
        p.perpId = perpId;
        p.startBlock = uint64(block.number + vm.envOr("LOCK_IN_BLOCKS", uint256(200_000)));
        p.endBlock = p.startBlock + uint64(vm.envOr("INTERVALS", uint256(24)) * perpl.getFundingInterval());
        p.threshold = vm.envOr("THRESHOLD", int256(1500));
        p.expectedScalingExp = uint8(perpl.getPerpetualInfoV2(perpId).fundingSumScalingExp);
        return abi.encode(p);
    }
}
