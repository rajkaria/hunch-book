// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Graduator} from "../../src/core/Graduator.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../../src/interfaces/IHunchBookFactory.sol";
import {IKuruMarginAccount} from "../../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {IKuruRouter} from "../../src/interfaces/external/IKuruRouter.sol";
import {MockFactoryForRouter, MockMarketForRouter} from "../mocks/MockMarketForRouter.sol";
import {MockTokenForRouter, MockVaultForRouter} from "../mocks/MockVaultForRouter.sol";

/// Fork fixture on Monad testnet: the real Kuru Router and MarginAccount (addresses from
/// deployments/monad-testnet.json), our test USDC and YES/NO tokens, the vault and market stand-ins,
/// a Graduator that creates real Kuru books, and the HunchRouter.
/// Run with: FOUNDRY_PROFILE=fork forge test --match-path "test/fork/Kuru*"
abstract contract KuruForkBase is Test {
    uint128 internal constant POOL_CAP = 5000e6;

    IKuruRouter internal kuruRouter;
    IKuruMarginAccount internal kuruMarginAccount;

    MockTokenForRouter internal usdc;
    MockTokenForRouter internal yes;
    MockTokenForRouter internal no;
    MockVaultForRouter internal vault;
    MockFactoryForRouter internal factory;
    MockMarketForRouter internal market;

    address internal maker = makeAddr("maker");

    function _fork() internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-testnet.json"));
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        assertEq(block.chainid, vm.parseJsonUint(json, ".chainId"));
        kuruRouter = IKuruRouter(vm.parseJsonAddress(json, ".external.kuru.router"));
        kuruMarginAccount = IKuruMarginAccount(vm.parseJsonAddress(json, ".external.kuru.marginAccount"));

        usdc = new MockTokenForRouter("Hunch Test USDC", "USDC", 6);
        yes = new MockTokenForRouter("YES", "YES", 6);
        no = new MockTokenForRouter("NO", "NO", 6);
        vault = new MockVaultForRouter(address(usdc));
        factory = new MockFactoryForRouter(address(vault), address(usdc));
        market = new MockMarketForRouter(address(yes), address(no), POOL_CAP);
        factory.setMarket(address(market), true);
    }

    function _params(uint256 takerFeeBps, uint256 makerFeeBps) internal pure returns (IGraduator.BookParams memory) {
        return IGraduator.BookParams({
            sizePrecision: 1e6,
            pricePrecision: 1e6,
            tickSize: 1000,
            minSize: 1e6,
            takerFeeBps: takerFeeBps,
            makerFeeBps: makerFeeBps,
            kuruAmmSpread: 30
        });
    }

    function _graduator(bool canCreate, IGraduator.BookParams memory p) internal returns (Graduator) {
        return
            new Graduator(
                IHunchBookFactory(address(factory)), kuruRouter, kuruMarginAccount, address(usdc), canCreate, p
            );
    }

    /// Deposits into Kuru's MarginAccount for `maker` and rests a limit order there.
    function _rest(IKuruOrderBook book, bool isBuy, uint32 price, uint96 size) internal {
        vm.startPrank(maker);
        if (isBuy) {
            uint256 quote = (uint256(price) * size + 1e6 - 1) / 1e6;
            usdc.mint(maker, quote);
            usdc.approve(address(kuruMarginAccount), quote);
            kuruMarginAccount.deposit(maker, address(usdc), quote);
            book.addBuyOrder(price, size, true);
        } else {
            yes.mint(maker, size);
            yes.approve(address(kuruMarginAccount), size);
            kuruMarginAccount.deposit(maker, address(yes), size);
            book.addSellOrder(price, size, true);
        }
        vm.stopPrank();
    }
}
