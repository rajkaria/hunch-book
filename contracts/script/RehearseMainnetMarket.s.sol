// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {ICollateralVault} from "../src/interfaces/ICollateralVault.sol";
import {IGraduator} from "../src/interfaces/IGraduator.sol";
import {IHunchBookFactory} from "../src/interfaces/IHunchBookFactory.sol";
import {IHunchRouter} from "../src/interfaces/IHunchRouter.sol";
import {IMarket} from "../src/interfaces/IMarket.sol";
import {Side} from "../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../src/interfaces/ITemplates.sol";
import {IKuruMarginAccount} from "../src/interfaces/external/IKuruMarginAccount.sol";
import {IKuruOrderBook} from "../src/interfaces/external/IKuruOrderBook.sol";
import {IKuruRouter} from "../src/interfaces/external/IKuruRouter.sol";

interface IERC20Rehearsal {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IOwnedRehearsal {
    function owner() external view returns (address);
}

interface IChainlinkLatestRehearsal {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// ANVIL ONLY. Walks one market through its life on a local anvil fork of Monad mainnet, one transaction
/// per step, each sent by the account that sends it on mainnet (creator, stakers, Kuru's owner, the
/// keeper, the maker, a trader), so the gas limit of every step can be read off the broadcast log.
/// Monad charges the gas limit, so those limits are the costs. It refuses to run on anything but anvil.
///
/// Needs a Hunch Book deployment on that fork in deployments/monad-mainnet.json (Deploy.s.sol and
/// GuardianBatch.s.sol broadcast to the same anvil), and MON on the keeper, the maker and Kuru's owner
/// (anvil_setBalance). USDC comes from a real Circle USDC holder (USDC_HOLDER), impersonated by anvil.
///
///   anvil --fork-url https://rpc.monad.xyz --network monad --auto-impersonate --port 18643
///   forge script script/RehearseMainnetMarket.s.sol --rpc-url http://127.0.0.1:18643 --unlocked \
///     --sender <keeper> --broadcast --slow --gas-estimate-multiplier 110
///
/// Restore deployments/monad-mainnet.json afterwards (git checkout): the anvil deploy wrote it.
contract RehearseMainnetMarket is Script {
    uint32 internal constant TEMPLATE_PRICE_AT_TIME = 2;
    uint256 internal constant STAKERS = 5;

    struct Ctx {
        IERC20Rehearsal usdc;
        IHunchBookFactory factory;
        ICollateralVault vault;
        IGraduator graduator;
        IHunchRouter router;
        IKuruRouter kuru;
        IKuruMarginAccount margin;
        address btcFeed;
        address keeper;
        address maker;
        address kuruOwner;
        address holder;
        address funder;
    }

    address internal creator = makeAddr("rehearsal creator");
    address internal trader = makeAddr("rehearsal trader");
    address[] internal stakers;

    function run() external {
        _requireAnvil();
        Ctx memory c = _ctx();
        for (uint256 i; i < STAKERS; ++i) {
            stakers.push(makeAddr(string.concat("rehearsal staker ", vm.toString(i))));
        }
        _setup(c);
        IMarket m = _createAndStake(c);
        address book = _kuruBookAndGraduate(c, m);
        _makerQuotes(c, m, book);
        _traderTrades(c, m);
        console2.log("market", address(m));
        console2.log("book", book);
    }

    /// Step 0, not a cost: MON for gas on the fresh accounts, USDC from a real holder.
    function _setup(Ctx memory c) internal {
        vm.startBroadcast(c.funder);
        payable(creator).transfer(1 ether);
        payable(trader).transfer(1 ether);
        for (uint256 i; i < STAKERS; ++i) {
            payable(stakers[i]).transfer(1 ether);
        }
        vm.stopBroadcast();

        require(c.usdc.balanceOf(c.holder) >= 5000e6, "USDC_HOLDER holds too little USDC");
        vm.startBroadcast(c.holder);
        c.usdc.transfer(creator, 100e6);
        c.usdc.transfer(trader, 200e6);
        c.usdc.transfer(c.maker, 1000e6);
        for (uint256 i; i < STAKERS; ++i) {
            c.usdc.transfer(stakers[i], 200e6);
        }
        vm.stopBroadcast();
    }

    /// Creator: approve and create a BTC price market (template 2, Chainlink). Five stakers: approve and
    /// stake; the first staker stakes a second time (a repeat stake).
    function _createAndStake(Ctx memory c) internal returns (IMarket m) {
        (, int256 answer,,,) = IChainlinkLatestRehearsal(c.btcFeed).latestRoundData();
        uint8 dec = IChainlinkLatestRehearsal(c.btcFeed).decimals();
        int256 strikeE8 = dec >= 8 ? answer / int256(10 ** (dec - 8)) : answer * int256(10 ** (8 - dec));
        PriceAtTimeParams memory p = PriceAtTimeParams({
            source: 0,
            feed: c.btcFeed,
            pythId: bytes32(0),
            strikeE8: strikeE8,
            lockTime: uint64(block.timestamp + 6 hours),
            closeTime: uint64(block.timestamp + 7 hours)
        });

        vm.startBroadcast(creator);
        c.usdc.approve(address(c.vault), type(uint256).max);
        m = IMarket(c.factory.createMarket(TEMPLATE_PRICE_AT_TIME, abi.encode(p), Side.Yes, 5e6));
        vm.stopBroadcast();

        for (uint256 i; i < STAKERS; ++i) {
            vm.startBroadcast(stakers[i]);
            c.usdc.approve(address(c.vault), type(uint256).max);
            m.stake(i < 3 ? Side.Yes : Side.No, 50e6);
            vm.stopBroadcast();
        }
        vm.startBroadcast(stakers[0]);
        m.stake(Side.Yes, 10e6);
        vm.stopBroadcast();
    }

    /// Kuru's owner creates the YES/USDC book with the Graduator's parameters; the keeper registers it,
    /// graduates the market and hands the stakers their tokens.
    function _kuruBookAndGraduate(Ctx memory c, IMarket m) internal returns (address book) {
        IGraduator.BookParams memory bp = c.graduator.bookParams();
        (address yes,) = m.tokens();
        vm.startBroadcast(c.kuruOwner);
        book = c.kuru
            .deployProxy(
                0,
                yes,
                address(c.usdc),
                bp.sizePrecision,
                bp.pricePrecision,
                bp.tickSize,
                bp.minSize,
                uint96(m.caps().poolCap),
                bp.takerFeeBps,
                bp.makerFeeBps,
                bp.kuruAmmSpread
            );
        vm.stopBroadcast();

        address[] memory all = new address[](STAKERS + 1);
        all[0] = creator;
        for (uint256 i; i < STAKERS; ++i) {
            all[i + 1] = stakers[i];
        }
        vm.startBroadcast(c.keeper);
        c.graduator.registerBook(address(m), book);
        m.graduate();
        m.claimTokensFor(all);
        vm.stopBroadcast();
    }

    /// The maker's first quote on a new book, then a requote (cancel both orders, place one bid and
    /// one ask), then a three-level requote.
    function _makerQuotes(Ctx memory c, IMarket m, address book) internal {
        (address yes,) = m.tokens();
        IKuruOrderBook b = IKuruOrderBook(book);
        vm.startBroadcast(c.maker);
        c.usdc.approve(address(c.vault), type(uint256).max);
        c.vault.mintSets(address(m), 300e6, c.maker);
        IERC20Rehearsal(yes).approve(address(c.margin), type(uint256).max);
        c.usdc.approve(address(c.margin), type(uint256).max);
        c.margin.deposit(c.maker, yes, 300e6);
        c.margin.deposit(c.maker, address(c.usdc), 300e6);
        uint40 first = b.s_orderIdCounter() + 1;
        b.addSellOrder(580_000, 50e6, true);
        b.addBuyOrder(540_000, 50e6, true);

        uint40[] memory cancel = new uint40[](2);
        (cancel[0], cancel[1]) = (first, first + 1);
        b.batchUpdate(_u32(545_000), _u96(50e6), _u32(575_000), _u96(50e6), cancel, true);

        uint40[] memory cancel2 = new uint40[](2);
        (cancel2[0], cancel2[1]) = (first + 2, first + 3);
        uint32[] memory bids = new uint32[](3);
        uint32[] memory asks = new uint32[](3);
        uint96[] memory sizes = new uint96[](3);
        for (uint256 i; i < 3; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            bids[i] = uint32(545_000 - i * 10_000);
            // forge-lint: disable-next-line(unsafe-typecast)
            asks[i] = uint32(575_000 + i * 10_000);
            sizes[i] = 20e6;
        }
        b.batchUpdate(bids, sizes, asks, sizes, cancel2, true);
        vm.stopBroadcast();
    }

    /// A trader buys YES, sells some back and buys NO through the router.
    function _traderTrades(Ctx memory c, IMarket m) internal {
        (address yes,) = m.tokens();
        vm.startBroadcast(trader);
        c.usdc.approve(address(c.router), type(uint256).max);
        uint256 bought = c.router.buyYes(address(m), 10e6, 1, block.timestamp + 1 days);
        IERC20Rehearsal(yes).approve(address(c.router), type(uint256).max);
        c.router.sellYes(address(m), bought / 2, 1, block.timestamp + 1 days);
        c.router.buyNo(address(m), 10e6, 10e6, block.timestamp + 1 days);
        vm.stopBroadcast();
    }

    function _ctx() internal view returns (Ctx memory c) {
        require(block.chainid == 143, "a fork of Monad mainnet only");
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
        require(vm.keyExistsJson(json, ".hunchBook.factory"), "no deployment in deployments/monad-mainnet.json");
        c.usdc = IERC20Rehearsal(vm.parseJsonAddress(json, ".hunchBook.usdc"));
        c.factory = IHunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        c.vault = ICollateralVault(vm.parseJsonAddress(json, ".hunchBook.vault"));
        c.graduator = IGraduator(vm.parseJsonAddress(json, ".hunchBook.graduator"));
        c.router = IHunchRouter(vm.parseJsonAddress(json, ".hunchBook.router"));
        c.kuru = IKuruRouter(vm.parseJsonAddress(json, ".external.kuru.router"));
        c.margin = IKuruMarginAccount(vm.parseJsonAddress(json, ".external.kuru.marginAccount"));
        c.btcFeed = vm.parseJsonAddress(json, ".external.chainlink['BTC/USD']");
        c.keeper = vm.parseJsonAddress(json, ".wallets.keeper");
        c.maker = vm.parseJsonAddress(json, ".wallets.maker");
        c.kuruOwner = IOwnedRehearsal(address(c.kuru)).owner();
        c.holder = vm.envOr("USDC_HOLDER", address(0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e));
        c.funder = msg.sender;
    }

    /// anvil answers anvil_nodeInfo; a real Monad RPC does not, so nothing here can reach a real chain.
    function _requireAnvil() internal {
        try vm.rpc("anvil_nodeInfo", "[]") returns (bytes memory) {}
        catch {
            revert("anvil only: this script impersonates accounts and must never point at a real RPC");
        }
    }

    function _u32(uint32 x) internal pure returns (uint32[] memory a) {
        a = new uint32[](1);
        a[0] = x;
    }

    function _u96(uint96 x) internal pure returns (uint96[] memory a) {
        a = new uint96[](1);
        a[0] = x;
    }
}
