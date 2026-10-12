// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SeedMainnetMarket} from "../../script/SeedMainnetMarket.s.sol";
import {HunchBookFactory} from "../../src/core/HunchBookFactory.sol";
import {Market} from "../../src/core/Market.sol";
import {Phase, Window} from "../../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../../src/interfaces/ITemplates.sol";

interface IUsdcFork {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// SeedMainnetMarket.s.sol against the LIVE mainnet deployment on a fork: the market it creates, who pays,
/// what each labelled seed wallet ends up holding, and the checks that stop a bad run before it sends
/// anything. Skips when the RPC is down.
///
///   FOUNDRY_PROFILE=fork forge test --match-path test/fork/SeedMainnetMarket.fork.t.sol
contract SeedMainnetMarketForkTest is Test {
    uint256 internal constant PAYER_KEY = 0xA11CE5EED;
    address[3] internal holders = [
        0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e,
        0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5, // Kuru's MarginAccount
        0x63e48B725540A3Db24ACF6682a29f877808C53F2
    ];

    SeedMainnetMarket internal script;
    HunchBookFactory internal factory;
    IUsdcFork internal usdc;
    address internal payer;
    string internal json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        try vm.createSelectFork(vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz"))) returns (uint256) {}
        catch {
            vm.skip(true, "Monad mainnet RPC unreachable");
            return;
        }
        script = new SeedMainnetMarket();
        factory = HunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        usdc = IUsdcFork(vm.parseJsonAddress(json, ".hunchBook.usdc"));
        payer = vm.addr(PAYER_KEY);
        vm.deal(payer, 2 ether);
    }

    function _fund(uint256 amount) internal {
        for (uint256 i; i < holders.length; ++i) {
            if (usdc.balanceOf(holders[i]) >= amount) {
                vm.prank(holders[i]);
                assertTrue(usdc.transfer(payer, amount));
                return;
            }
        }
        deal(address(usdc), payer, amount);
    }

    function _config(uint256 count, uint256 yes, uint256 each, uint64 close)
        internal
        returns (SeedMainnetMarket.Config memory c)
    {
        address[] memory all = script.seededWallets();
        c.templateId = 2;
        c.params = script.priceAtTimeParams("BTC/USD", 83_500e8, close - 30 minutes, close);
        c.creatorStake = 5e6;
        c.seeded = new address[](count);
        for (uint256 i; i < count; ++i) {
            c.seeded[i] = all[i];
        }
        c.yesCount = yes;
        c.each = each;
    }

    function test_seedsTheMarket_paidByTheDeployer_forEveryLabelledWallet() public {
        address[] memory seeded = script.seededWallets();
        assertEq(seeded.length, 15, "fifteen labelled seed wallets");
        uint64 close = uint64(block.timestamp + 6 hours);
        _fund(20e6);
        uint256 before = factory.marketCount();

        Market m = script.seedWith(PAYER_KEY, _config(15, 7, 1e6, close));

        assertEq(factory.marketCount(), before + 1);
        assertEq(m.creator(), payer);
        assertEq(m.templateId(), 2);
        assertEq(uint8(m.phase()), uint8(Phase.Pool));
        (uint256 yesTotal, uint256 noTotal, uint32 stakers) = m.poolTotals();
        assertEq(yesTotal, 12e6, "creator 5 + seven seeded 1 USDC on YES");
        assertEq(noTotal, 8e6, "eight seeded 1 USDC on NO");
        assertEq(stakers, 16);
        assertTrue(m.graduationRuleMet(), "20 USDC from 16 wallets meets the 10 USDC / 2 wallet rule");
        for (uint256 i; i < 15; ++i) {
            (uint256 y, uint256 n) = m.stakeOf(seeded[i]);
            assertEq(y, i < 7 ? 1e6 : 0);
            assertEq(n, i < 7 ? 0 : 1e6);
            assertEq(usdc.balanceOf(seeded[i]), 0, "a seeded wallet holds no USDC: the deployer paid");
        }
        // The deployer paid exactly the plan and left no allowance behind.
        assertEq(usdc.balanceOf(payer), 0);
        assertEq(usdc.allowance(payer, factory.vault()), 0);
        // The question reads as the params say: BTC/USD at or above $83,500 at close, per Chainlink.
        Window memory w = m.window();
        assertEq(w.close, close);
        assertEq(w.lock, close - 30 minutes);
        PriceAtTimeParams memory p = abi.decode(m.params(), (PriceAtTimeParams));
        assertEq(p.feed, vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']"));
        assertEq(p.strikeE8, 83_500e8);
    }

    function test_kuruMarket_creatorAndOneSeededWallet_meetTheRuleExactly() public {
        _fund(10e6);
        SeedMainnetMarket.Config memory c = _config(1, 0, 5e6, uint64(block.timestamp + 21 days));
        Market m = script.seedWith(PAYER_KEY, c);
        (uint256 yesTotal, uint256 noTotal, uint32 stakers) = m.poolTotals();
        assertEq(yesTotal, 5e6);
        assertEq(noTotal, 5e6);
        assertEq(stakers, 2);
        assertTrue(m.graduationRuleMet());
    }

    function test_refuses_whenTheDeployerHoldsTooLittleUsdc() public {
        _fund(19e6);
        SeedMainnetMarket.Config memory c = _config(15, 7, 1e6, uint64(block.timestamp + 6 hours));
        vm.expectRevert(bytes("deployer holds too little USDC: send the difference to the deployer"));
        script.seedWith(PAYER_KEY, c);
    }

    function test_refuses_whenStakingStopsTooSoon() public {
        _fund(20e6);
        // Close in 35 minutes: staking stops in 5, under the 10 the seeded stakes need.
        SeedMainnetMarket.Config memory c = _config(15, 7, 1e6, uint64(block.timestamp + 35 minutes));
        vm.expectRevert(bytes("staking stops in under 10 minutes: pick a later CLOSE or LOCK"));
        script.seedWith(PAYER_KEY, c);
    }

    function test_refuses_moreYesStakersThanStakers() public {
        _fund(20e6);
        SeedMainnetMarket.Config memory c = _config(3, 4, 1e6, uint64(block.timestamp + 6 hours));
        vm.expectRevert(bytes("SEEDED_YES is more than SEEDED_COUNT"));
        script.seedWith(PAYER_KEY, c);
    }

    function test_refuses_withoutGasMoney() public {
        _fund(20e6);
        vm.deal(payer, 0.5 ether);
        SeedMainnetMarket.Config memory c = _config(15, 7, 1e6, uint64(block.timestamp + 6 hours));
        vm.expectRevert(bytes("deployer holds under 1 MON for gas"));
        script.seedWith(PAYER_KEY, c);
    }
}
