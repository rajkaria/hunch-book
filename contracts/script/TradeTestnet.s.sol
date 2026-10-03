// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {HunchRouter} from "../src/core/HunchRouter.sol";
import {Market} from "../src/core/Market.sol";
import {TestUSDC} from "../src/mocks/TestUSDC.sol";
import {IKuruOrderBook} from "../src/interfaces/external/IKuruOrderBook.sol";

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Testnet only. Sends one trade down each router path on a graduated market (buy YES, sell YES,
/// buy NO, sell NO) from the deployer, with slippage limits taken from the live book. Our own wallet
/// trades here, so these fills are ours and counted as ours.
///
///   DEPLOYER_PRIVATE_KEY=... MARKET=0x... SIZE=5000000 forge script script/TradeTestnet.s.sol \
///     --rpc-url $MONAD_TESTNET_RPC --broadcast --slow --gas-estimate-multiplier 110
contract TradeTestnet is Script {
    /// Accept at most 3% worse than the touch.
    uint256 internal constant SLIPPAGE_BPS = 300;

    HunchRouter internal router;
    TestUSDC internal usdc;
    Market internal m;
    uint256 internal size;
    uint256 internal bid;
    uint256 internal ask;

    function run() external {
        require(block.chainid == 10_143, "testnet only");
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        router = HunchRouter(vm.parseJsonAddress(json, ".hunchBook.router"));
        usdc = TestUSDC(vm.parseJsonAddress(json, ".hunchBook.usdc"));
        m = Market(payable(vm.envAddress("MARKET")));
        size = vm.envOr("SIZE", uint256(5e6));

        // bestBidAsk is USDC per YES scaled by 1e18. Kuru reads an empty bid as uint256 max, an empty ask as 0.
        (bid, ask) = IKuruOrderBook(m.book()).bestBidAsk();
        require(bid != 0 && bid != type(uint256).max && ask != 0 && ask != type(uint256).max, "book is not two-sided");
        console2.log("best bid (1e18)", bid);
        console2.log("best ask (1e18)", ask);

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        _approve(vm.addr(pk));
        _tradeYes();
        _tradeNo();
        vm.stopBroadcast();
    }

    function _approve(address me) internal {
        if (usdc.balanceOf(me) < 100e6) usdc.mint(me, 1000e6);
        (address yes, address no) = m.tokens();
        usdc.approve(address(router), type(uint256).max);
        IERC20Approve(yes).approve(address(router), type(uint256).max);
        IERC20Approve(no).approve(address(router), type(uint256).max);
    }

    /// Buy YES with `size` USDC (expect size / ask YES), then sell them back (expect yesOut * bid).
    function _tradeYes() internal {
        uint256 minYes = size * 1e18 / ask * (10_000 - SLIPPAGE_BPS) / 10_000;
        uint256 yesOut = router.buyYes(address(m), size, minYes, block.timestamp + 300);
        uint256 minUsdc = yesOut * bid / 1e18 * (10_000 - SLIPPAGE_BPS) / 10_000;
        uint256 usdcBack = router.sellYes(address(m), yesOut, minUsdc, block.timestamp + 300);
        console2.log("buyYes: YES out", yesOut);
        console2.log("sellYes: USDC out", usdcBack);
    }

    /// Buy `size` NO (costs size * (1 - bid)), then sell them (receives size - quoteSellNo).
    function _tradeNo() internal {
        uint256 maxIn = size * (1e18 - bid) / 1e18 * (10_000 + SLIPPAGE_BPS) / 10_000 + 1;
        uint256 noCost = router.buyNo(address(m), size, maxIn, block.timestamp + 300);
        uint256 minOut = (size - router.quoteSellNo(address(m), size)) * (10_000 - SLIPPAGE_BPS) / 10_000;
        uint256 noBack = router.sellNo(address(m), size, minOut, block.timestamp + 300);
        console2.log("buyNo: USDC paid", noCost);
        console2.log("sellNo: USDC out", noBack);
    }
}
