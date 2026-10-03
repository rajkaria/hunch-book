// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {Market} from "../src/core/Market.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {Side} from "../src/interfaces/IHunchBookTypes.sol";
import {PerplFundingParams} from "../src/interfaces/ITemplates.sol";
import {IPerplExchange} from "../src/interfaces/external/IPerplExchange.sol";

/// Testnet only. Creates a Perpl funding market (template 1) and fills its pool from Hunch Book's
/// own wallets so it meets the graduation rule, then graduates it into a new Kuru book and pushes
/// every staker's tokens. This activity is ours and is labelled as ours wherever it is counted:
/// the creator is the deployer and the ten stakers are addresses derived from the deployer key
/// (label "hunch-book testnet seed"), so anyone can see they are one party.
///
///   DEPLOYER_PRIVATE_KEY=... PERP_ID=64 THRESHOLD=1500 forge script script/SeedTestnetMarket.s.sol \
///     --rpc-url $MONAD_TESTNET_RPC --broadcast --slow --gas-estimate-multiplier 110
///
/// Env: PERP_ID (default 64, MON), THRESHOLD (raw Perpl units; default 1500), LOCK_IN_BLOCKS
/// (default 200,000, about 17 hours), INTERVALS (default 24 funding intervals in the window).
contract SeedTestnetMarket is Script {
    uint32 internal constant TEMPLATE_PERPL_FUNDING = 1;

    function run() external {
        require(block.chainid == 10_143, "testnet only");
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        HunchBookFactory factory = HunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        TestUSDC usdc = TestUSDC(vm.parseJsonAddress(json, ".hunchBook.usdc"));
        IPerplExchange perpl = IPerplExchange(vm.parseJsonAddress(json, ".external.perpl.exchange"));

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 perpId = vm.envOr("PERP_ID", uint256(64));
        PerplFundingParams memory p;
        p.perpId = perpId;
        p.startBlock = uint64(block.number + vm.envOr("LOCK_IN_BLOCKS", uint256(200_000)));
        p.endBlock = p.startBlock + uint64(vm.envOr("INTERVALS", uint256(24)) * perpl.getFundingInterval());
        p.threshold = int256(vm.envOr("THRESHOLD", uint256(1500)));
        p.expectedScalingExp = uint8(perpl.getPerpetualInfoV2(perpId).fundingSumScalingExp);
        bytes memory params = abi.encode(p);

        address[] memory stakers = new address[](11);
        stakers[0] = vm.addr(pk);
        for (uint256 i = 1; i < 11; ++i) {
            stakers[i] = vm.addr(uint256(keccak256(abi.encode("hunch-book testnet seed", pk, i))) % (2 ** 255));
        }

        vm.startBroadcast(pk);
        usdc.mint(stakers[0], 1000e6);
        usdc.approve(factory.vault(), type(uint256).max);
        Market m = Market(payable(factory.createMarket(TEMPLATE_PERPL_FUNDING, params, Side.Yes, 50e6)));
        // Six YES at 60 and four NO at 70: 410 YES / 280 NO, a 59% implied chance.
        for (uint256 i = 1; i < 11; ++i) {
            m.stakeFor(stakers[i], i <= 6 ? Side.Yes : Side.No, i <= 6 ? 60e6 : 70e6);
        }
        m.graduate();
        m.claimTokensFor(stakers);
        vm.stopBroadcast();

        console2.log("market", address(m));
        console2.log("book", m.book());
        console2.log(m.resolver().describe(params));
    }
}
