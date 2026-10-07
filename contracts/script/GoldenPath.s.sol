// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {Market} from "../src/core/Market.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IImpliedProbabilityOracle} from "../src/periphery/interfaces/IImpliedProbabilityOracle.sol";
import {IOutcomeTokenPriceAdapterFactory} from "../src/periphery/interfaces/IOutcomeTokenPriceAdapterFactory.sol";
import {GraduationRule, MarketCaps, Side} from "../src/interfaces/IHunchBookTypes.sol";
import {PerplFundingParams} from "../src/interfaces/ITemplates.sol";
import {IPerplExchange} from "../src/interfaces/external/IPerplExchange.sol";
import {ResolverText} from "../src/resolvers/ResolverText.sol";

/// Testnet only. Sets up a Perpl MON funding market (template 1) for a person to walk the whole
/// lifecycle in the app with two of their own wallets (docs/GOLDEN-PATH.md).
///
/// The deployer creates the market and makes the first stake; then addresses derived from the
/// deployer key stake, exactly as `SeedTestnetMarket.s.sol` derives and labels them
/// ("hunch-book testnet seed"), so anyone can see they are one party: ours. The pool is left just
/// short of the graduation rule, in stakers and in USDC, so two more outside wallets staking at
/// least the printed amounts make it graduate. Every stake made here is ours and counted as ours.
///
///   DEPLOYER_PRIVATE_KEY=... MONAD_TESTNET_RPC=... forge script script/GoldenPath.s.sol \
///     --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 110
///
/// Leave out --broadcast for a dry run: it prints everything without sending a transaction.
///
/// Env (all optional):
///   LOCK_AT_UNIX     the lock must come after this unix time (default: now)
///   MARGIN_MINUTES   safety margin added after LOCK_AT_UNIX (default 60)
///   WINDOW_INTERVALS funding intervals of 8,571 blocks in the window (default 2, about 86 minutes)
///   THRESHOLD_RAW    threshold in Perpl's raw units (default: from recent funding, so the chance is
///                    near half; the reasoning is printed)
///   SEED_STAKERS     stakers our wallets put in, the deployer's first stake included (default 8)
///   GAP_USDC         how far short of the pool minimum to stop, in whole USDC (default 20)
///   BLOCK_TIME_MS    skip measuring the block time and use this (default: measured over 10,000
///                    blocks through a second fork of MONAD_TESTNET_RPC)
///   STACK            an extra stack's name under `.stacks` (e.g. kuruV2); default the primary stack.
///                    On a stack with a `periphery.kuruFeedFactory` (Kuru v2), the script also creates
///                    the market's YES and NO feeds for Kuru's withdrawal limiter and pokes the oracle, so
///                    the feeds have history before Kuru sets the tokens up (PROTOCOL.md §8.1, Kuru v2).
contract GoldenPath is Script {
    uint32 internal constant TEMPLATE_PERPL_FUNDING = 1;
    /// The same label SeedTestnetMarket uses, so these wallets are recognisably ours.
    string internal constant SEED_LABEL = "hunch-book testnet seed";
    uint256 internal constant PACE_SPAN = 10_000;
    /// Funding events read to choose a threshold: about 34 hours.
    uint256 internal constant HISTORY = 48;
    uint256 internal constant IST_OFFSET = 5 hours + 30 minutes;

    struct Plan {
        uint256 head;
        uint256 headTime;
        uint256 msPerBlock;
        uint256 lockAt;
        uint256 interval;
        uint256 intervals;
        uint256 perpId;
        uint256 decimals;
        int256 threshold;
        uint256 seedStakers;
        uint256 outsiders;
        uint256 seeded;
        uint256 gap;
        uint256 creatorStake;
        uint256 perStake;
    }

    HunchBookFactory internal factory;
    TestUSDC internal usdc;
    IPerplExchange internal perpl;

    function run() external {
        require(block.chainid == 10_143, "testnet only");
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        string memory stack = _stackPath();
        factory = HunchBookFactory(vm.parseJsonAddress(json, string.concat(stack, ".factory")));
        usdc = TestUSDC(vm.parseJsonAddress(json, string.concat(stack, ".usdc")));
        perpl = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));
        require(!factory.creationPaused(), "market creation is paused");

        Plan memory plan;
        plan.perpId = vm.parseJsonUint(json, ".external.perpl.perps.MON");
        plan.head = vm.getBlockNumber();
        plan.headTime = vm.getBlockTimestamp();
        plan.msPerBlock = _blockTimeMs();
        plan.lockAt = vm.envOr("LOCK_AT_UNIX", plan.headTime) + vm.envOr("MARGIN_MINUTES", uint256(60)) * 60;
        plan.interval = perpl.getFundingInterval();
        plan.intervals = vm.envOr("WINDOW_INTERVALS", uint256(2));
        require(plan.intervals >= 1, "WINDOW_INTERVALS must be at least 1");

        IPerplExchange.PerpetualInfoV2 memory info = perpl.getPerpetualInfoV2(plan.perpId);
        plan.decimals = info.priceDecimals + info.fundingSumScalingExp;

        PerplFundingParams memory p;
        p.perpId = plan.perpId;
        p.startBlock = uint64(_lockBlock(plan));
        p.endBlock = p.startBlock + uint64(plan.intervals * plan.interval);
        p.expectedScalingExp = uint8(info.fundingSumScalingExp);
        p.threshold = _threshold(plan);
        plan.threshold = p.threshold;
        bytes memory params = abi.encode(p);

        bytes32 key = factory.marketKey(TEMPLATE_PERPL_FUNDING, params);
        address already = factory.marketOf(key);
        require(already == address(0), string.concat("this exact market exists: ", vm.toString(already)));

        _planStakes(plan);
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Market m = _createAndSeed(pk, params, plan);
        _createKuruFeeds(pk, json, stack, m);

        _report(m, p, plan, key);
        _reportSeeds(pk, plan);
    }

    // ---------------------------------------------------------------- planning

    /// Milliseconds per block over the last PACE_SPAN blocks, read from a second fork, or BLOCK_TIME_MS.
    function _blockTimeMs() internal returns (uint256 ms) {
        ms = vm.envOr("BLOCK_TIME_MS", uint256(0));
        if (ms != 0) {
            console2.log("Block time from BLOCK_TIME_MS (ms):", ms);
            return ms;
        }
        uint256 head = vm.getBlockNumber();
        uint256 headTime = vm.getBlockTimestamp();
        uint256 mainFork = vm.activeFork();
        vm.createSelectFork(vm.rpcUrl("monad_testnet"), head - PACE_SPAN);
        uint256 earlier = vm.getBlockTimestamp();
        vm.selectFork(mainFork);
        require(headTime > earlier, "could not measure the block time");
        // Rounded down: a slightly fast estimate puts the lock block later in clock time, never earlier.
        ms = ((headTime - earlier) * 1000) / PACE_SPAN;
        console2.log("Measured block time over the last 10,000 blocks (ms):", ms);
    }

    /// The first funding-grid block at least (lockAt - now) away at the measured block time.
    function _lockBlock(Plan memory plan) internal view returns (uint256) {
        uint256 secondsAhead = plan.lockAt > plan.headTime ? plan.lockAt - plan.headTime : 0;
        uint256 blocksAhead = (secondsAhead * 1000 + plan.msPerBlock - 1) / plan.msPerBlock;
        (, uint256 lastEvent) = perpl.getFundingSumAtBlock(plan.perpId, plan.head);
        uint256 anchor = lastEvent % plan.interval;
        uint256 target = plan.head + blocksAhead + 1;
        uint256 offset = (target + plan.interval - anchor) % plan.interval;
        return offset == 0 ? target : target + plan.interval - offset;
    }

    /// THRESHOLD_RAW, or the value past windows of the same length beat about half the time.
    function _threshold(Plan memory plan) internal view returns (int256 threshold) {
        if (vm.envExists("THRESHOLD_RAW")) {
            threshold = vm.envInt("THRESHOLD_RAW");
            console2.log("Threshold from THRESHOLD_RAW (raw units):", vm.toString(threshold));
            return threshold;
        }
        (, uint256 lastEvent) = perpl.getFundingSumAtBlock(plan.perpId, plan.head);
        int256[] memory deltas = new int256[](HISTORY);
        (int48 previous,) = perpl.getFundingSumAtBlock(plan.perpId, lastEvent - HISTORY * plan.interval);
        int256 total = 0;
        for (uint256 k = 0; k < HISTORY; ++k) {
            (int48 sum,) = perpl.getFundingSumAtBlock(plan.perpId, lastEvent - (HISTORY - 1 - k) * plan.interval);
            deltas[k] = int256(sum) - int256(previous);
            total += deltas[k];
            previous = sum;
        }
        uint256 windows = HISTORY - plan.intervals + 1;
        int256[] memory sums = new int256[](windows);
        for (uint256 w = 0; w < windows; ++w) {
            for (uint256 j = 0; j < plan.intervals; ++j) {
                sums[w] += deltas[w + j];
            }
        }
        // The candidate whose "more than X" count is closest to half of the past windows.
        uint256 bestGap = type(uint256).max;
        uint256 bestHits = 0;
        for (uint256 c = 0; c < windows; ++c) {
            uint256 hits = 0;
            for (uint256 w = 0; w < windows; ++w) {
                if (sums[w] > sums[c]) ++hits;
            }
            uint256 gap = hits * 2 > windows ? hits * 2 - windows : windows - hits * 2;
            if (gap < bestGap || (gap == bestGap && sums[c] < threshold)) {
                bestGap = gap;
                bestHits = hits;
                threshold = sums[c];
            }
        }
        console2.log("Threshold reasoning, from Perpl's funding history:");
        console2.log(
            string.concat(
                "  last ",
                vm.toString(HISTORY),
                " funding events: average ",
                ResolverText.usd(total / int256(HISTORY), plan.decimals),
                " per MON per event (",
                vm.toString(total / int256(HISTORY)),
                " raw)"
            )
        );
        console2.log(
            string.concat(
                "  a window of ",
                vm.toString(plan.intervals),
                " events paid more than ",
                ResolverText.usd(threshold, plan.decimals),
                " (",
                vm.toString(threshold),
                " raw) in ",
                vm.toString(bestHits),
                " of the last ",
                vm.toString(windows),
                " windows, so YES starts near a coin flip"
            )
        );
    }

    /// Splits the seeded pool so it stops `gap` short of the minimum with `seedStakers` stakers, half
    /// on each side, leaving the rest of the stakers for outside wallets.
    function _planStakes(Plan memory plan) internal view {
        IHunchBookFactory.Template memory t = factory.templateOf(TEMPLATE_PERPL_FUNDING);
        GraduationRule memory rule = t.rule;
        MarketCaps memory caps = factory.caps();
        plan.seedStakers = vm.envOr("SEED_STAKERS", uint256(8));
        plan.gap = vm.envOr("GAP_USDC", uint256(20)) * 1e6;
        require(plan.seedStakers >= 2, "SEED_STAKERS must be at least 2 (one per side)");
        require(plan.seedStakers < rule.minStakers, "SEED_STAKERS must leave the staker rule unmet");
        plan.outsiders = rule.minStakers - plan.seedStakers;
        require(plan.gap >= plan.outsiders * caps.minStake, "GAP_USDC is too small for the outside stakes");
        require(plan.gap < rule.minPool, "GAP_USDC must be below the pool minimum");
        plan.seeded = rule.minPool - plan.gap;
        plan.perStake = plan.seeded / plan.seedStakers;
        plan.creatorStake = plan.seeded - plan.perStake * (plan.seedStakers - 1);
        require(plan.creatorStake >= caps.creatorMinStake, "first stake below the creator minimum");
        require(plan.creatorStake <= caps.walletCap && plan.perStake <= caps.walletCap, "stake above the wallet cap");
    }

    // ---------------------------------------------------------------- transactions

    function _seed(uint256 pk, uint256 i) internal pure returns (address) {
        return vm.addr(uint256(keccak256(abi.encode(SEED_LABEL, pk, i))) % (2 ** 255));
    }

    /// Side for staker i: the first half YES (the deployer's first stake included), the rest NO.
    function _side(Plan memory plan, uint256 i) internal pure returns (Side) {
        return i < plan.seedStakers / 2 ? Side.Yes : Side.No;
    }

    function _createAndSeed(uint256 pk, bytes memory params, Plan memory plan) internal returns (Market m) {
        address deployer = vm.addr(pk);
        address vault = factory.vault();
        vm.startBroadcast(pk);
        uint256 balance = usdc.balanceOf(deployer);
        if (balance < plan.seeded) usdc.mint(deployer, plan.seeded - balance);
        if (usdc.allowance(deployer, vault) < plan.seeded) usdc.approve(vault, type(uint256).max);
        m = Market(payable(factory.createMarket(TEMPLATE_PERPL_FUNDING, params, Side.Yes, plan.creatorStake)));
        for (uint256 i = 1; i < plan.seedStakers; ++i) {
            m.stakeFor(_seed(pk, i), _side(plan, i), plan.perStake);
        }
        vm.stopBroadcast();
    }

    /// On a Kuru v2 stack: the market's YES and NO limiter feeds, and a first oracle observation.
    function _createKuruFeeds(uint256 pk, string memory json, string memory stack, Market m) internal {
        string memory feedsKey = string.concat(stack, ".periphery.kuruFeedFactory");
        if (!vm.keyExistsJson(json, feedsKey)) return;
        IOutcomeTokenPriceAdapterFactory feeds = IOutcomeTokenPriceAdapterFactory(vm.parseJsonAddress(json, feedsKey));
        IImpliedProbabilityOracle oracle = IImpliedProbabilityOracle(
            vm.parseJsonAddress(json, string.concat(stack, ".periphery.impliedProbabilityOracle"))
        );
        vm.startBroadcast(pk);
        address yesFeed = feeds.createAdapter(address(m), Side.Yes);
        address noFeed = feeds.createAdapter(address(m), Side.No);
        oracle.poke(address(m));
        vm.stopBroadcast();
        console2.log("Kuru limiter feed, YES:", yesFeed);
        console2.log("Kuru limiter feed, NO: ", noFeed);
    }

    function _stackPath() internal view returns (string memory) {
        string memory stack = vm.envOr("STACK", string(""));
        return bytes(stack).length == 0 ? ".hunchBook" : string.concat(".stacks.", stack);
    }

    // ---------------------------------------------------------------- report

    function _report(Market m, PerplFundingParams memory p, Plan memory plan, bytes32 key) internal view {
        (uint256 yes, uint256 no, uint256 stakers) = m.poolTotals();
        uint256 lockTime = _timeAt(p.startBlock, plan);
        uint256 closeTime = _timeAt(p.endBlock, plan);

        console2.log("");
        console2.log("Golden path market (ours: created and seeded from Hunch Book's own wallets)");
        string memory addr = vm.toString(address(m));
        console2.log(string.concat("  market:   ", addr));
        console2.log(string.concat("  key:      ", vm.toString(key)));
        console2.log(string.concat("  app:      https://book.playhunch.xyz/m/", addr));
        console2.log(string.concat("  explorer: https://testnet.monadscan.com/address/", addr));
        console2.log("  rule:    ", m.resolver().describe(m.params()));
        console2.log("  lock block: ", uint256(p.startBlock), string.concat("about ", _when(lockTime)));
        console2.log("  close block:", uint256(p.endBlock), string.concat("about ", _when(closeTime)));
        console2.log(
            string.concat(
                "  estimates use ",
                vm.toString(plan.msPerBlock),
                " ms per block; the lock is at least ",
                vm.toString(vm.envOr("MARGIN_MINUTES", uint256(60))),
                " minutes after LOCK_AT_UNIX"
            )
        );
        console2.log(
            string.concat(
                "  pool now: ",
                _usdc(yes),
                " USDC YES, ",
                _usdc(no),
                " USDC NO, ",
                vm.toString(stakers),
                " stakers (all ours)"
            )
        );
        console2.log("");
        console2.log("What the two outside wallets must do, before the lock block:");
        uint256 each = (plan.gap + plan.outsiders - 1) / plan.outsiders;
        for (uint256 i = 0; i < plan.outsiders; ++i) {
            console2.log(
                string.concat(
                    "  wallet ",
                    i == 0 ? "A" : i == 1 ? "B" : vm.toString(i + 1),
                    ": stake at least ",
                    _usdc(each),
                    " USDC on ",
                    i % 2 == 0 ? "YES" : "NO"
                )
            );
        }
        console2.log(
            string.concat(
                "  then the pool holds at least ",
                _usdc(plan.seeded + each * plan.outsiders),
                " USDC from ",
                vm.toString(plan.seedStakers + plan.outsiders),
                " stakers on both sides, and anyone can graduate it"
            )
        );
    }

    /// Our seed wallets, so anyone reading the chain can match them to this script.
    function _reportSeeds(uint256 pk, Plan memory plan) internal pure {
        console2.log("");
        console2.log(string.concat("Our stakers (label \"", SEED_LABEL, "\", derived from the deployer key):"));
        console2.log(string.concat("  creator (deployer): ", vm.toString(vm.addr(pk)), " on YES"));
        for (uint256 i = 1; i < plan.seedStakers; ++i) {
            console2.log(
                string.concat(
                    "  seed ",
                    vm.toString(i),
                    ": ",
                    vm.toString(_seed(pk, i)),
                    _side(plan, i) == Side.Yes ? " on YES" : " on NO"
                )
            );
        }
    }

    function _timeAt(uint256 blockNumber, Plan memory plan) internal pure returns (uint256) {
        return plan.headTime + ((blockNumber - plan.head) * plan.msPerBlock) / 1000;
    }

    /// "2026-10-04 13:05 UTC (2026-10-04 18:35 IST)".
    function _when(uint256 ts) internal pure returns (string memory) {
        return string.concat(_clock(ts), " UTC (", _clock(ts + IST_OFFSET), " IST)");
    }

    function _clock(uint256 ts) internal pure returns (string memory) {
        (uint256 y, uint256 mo, uint256 d,,,) = DateTimeLib.timestampToDateTime(ts);
        return string.concat(LibString.toString(y), "-", _two(mo), "-", _two(d), " ", _hm(ts));
    }

    function _hm(uint256 ts) internal pure returns (string memory) {
        (,,, uint256 h, uint256 mi,) = DateTimeLib.timestampToDateTime(ts);
        return string.concat(_two(h), ":", _two(mi));
    }

    function _two(uint256 v) internal pure returns (string memory) {
        return v < 10 ? string.concat("0", LibString.toString(v)) : LibString.toString(v);
    }

    function _usdc(uint256 amount) internal pure returns (string memory) {
        return ResolverText.decimal(amount, 6);
    }
}
