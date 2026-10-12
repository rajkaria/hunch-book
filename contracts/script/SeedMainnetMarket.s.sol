// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {HunchBookFactory} from "../src/core/HunchBookFactory.sol";
import {Market} from "../src/core/Market.sol";
import {Side} from "../src/interfaces/IHunchBookTypes.sol";
import {PriceAtTimeParams} from "../src/interfaces/ITemplates.sol";

interface IUsdcSeed {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// Mainnet. Creates one market from the deployer and stakes in it for Hunch Book's labelled seed wallets
/// (`wallets.seeded` in deployments/monad-mainnet.json). This activity is ours and is labelled as ours
/// wherever it is counted: the deployer is the stack's fee recipient (a wallet the indexer already
/// labels ours), and it pays every seeded stake with `stakeFor`, so the seeded wallets hold no USDC and
/// no MON and the indexer labels each one Seeded, both from the deployments file and from who paid.
///
/// Template 2 (Chainlink price at a time) by default. Nothing is sent without --broadcast; run it once
/// without to read the question, the totals and every stake:
///
///   PAIR=BTC/USD STRIKE_E8=8350000000000 CLOSE=1791788400 forge script script/SeedMainnetMarket.s.sol \
///     --rpc-url monad_mainnet --broadcast --slow --gas-estimate-multiplier 110 \
///     --with-gas-price 120gwei --priority-gas-price 2gwei
///
/// Env: DEPLOYER_PRIVATE_KEY (from .env), PAIR (a key under `external.chainlink`, default BTC/USD),
/// STRIKE_E8 (USD, 8 decimals), CLOSE (unix seconds: the observation time), LOCK (unix seconds: staking
/// stops; default 30 minutes before CLOSE), CREATOR_STAKE (whole USDC on YES, default 5, the minimum),
/// SEEDED_FIRST (1-based index into `wallets.seeded`, default 1), SEEDED_COUNT (default every listed
/// wallet), SEEDED_YES (how many of them stake YES, the rest NO; default half, rounded down),
/// SEEDED_EACH (whole USDC per seeded wallet, default 1, the minimum). Any template: TEMPLATE=<id>
/// PARAMS=<abi-encoded params, 0x...>.
contract SeedMainnetMarket is Script {
    uint32 internal constant TEMPLATE_PRICE_AT_TIME = 2;
    uint8 internal constant SOURCE_CHAINLINK = 0;
    /// The seeded stakes must land before staking stops; the transactions go out one at a time.
    uint256 internal constant MIN_LEAD = 10 minutes;
    /// Gas headroom for createMarket and up to 15 stakes at ~120 gwei (about 0.5 MON measured).
    uint256 internal constant MIN_MON = 1 ether;

    struct Config {
        uint32 templateId;
        bytes params;
        uint256 creatorStake; // USDC, 6 decimals, on YES
        address[] seeded; // the wallets the deployer stakes for
        uint256 yesCount; // the first `yesCount` of them stake YES, the rest NO
        uint256 each; // USDC, 6 decimals, per seeded wallet
    }

    string internal json;

    function run() external returns (Market) {
        require(block.chainid == 143, "mainnet only");
        _load();
        Config memory c;
        c.templateId = uint32(vm.envOr("TEMPLATE", uint256(TEMPLATE_PRICE_AT_TIME)));
        c.params = vm.envOr("PARAMS", bytes(""));
        if (c.params.length == 0) {
            require(c.templateId == TEMPLATE_PRICE_AT_TIME, "PARAMS is required for this template");
            uint256 close = vm.envUint("CLOSE");
            c.params = priceAtTimeParams(
                vm.envOr("PAIR", string("BTC/USD")),
                vm.envInt("STRIKE_E8"),
                uint64(vm.envOr("LOCK", close - 30 minutes)),
                uint64(close)
            );
        }
        c.creatorStake = vm.envOr("CREATOR_STAKE", uint256(5)) * 1e6;
        address[] memory all = seededWallets();
        uint256 first = vm.envOr("SEEDED_FIRST", uint256(1));
        uint256 count = vm.envOr("SEEDED_COUNT", all.length - (first - 1));
        require(first >= 1 && first - 1 + count <= all.length, "SEEDED_FIRST/SEEDED_COUNT outside wallets.seeded");
        c.seeded = new address[](count);
        for (uint256 i; i < count; ++i) {
            c.seeded[i] = all[first - 1 + i];
        }
        c.yesCount = vm.envOr("SEEDED_YES", count / 2);
        c.each = vm.envOr("SEEDED_EACH", uint256(1)) * 1e6;
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // The payer must be a wallet the indexer labels ours, or the seeded stakes would read as outside money.
        require(vm.addr(pk) == vm.parseJsonAddress(json, ".hunchBook.feeRecipient"), "signer is not the deployer");
        return seedWith(pk, c);
    }

    /// Checks, prints the plan, then creates the market and stakes for each seeded wallet.
    function seedWith(uint256 pk, Config memory c) public returns (Market m) {
        if (bytes(json).length == 0) _load();
        HunchBookFactory factory = HunchBookFactory(vm.parseJsonAddress(json, ".hunchBook.factory"));
        IUsdcSeed usdc = IUsdcSeed(vm.parseJsonAddress(json, ".hunchBook.usdc"));
        address deployer = vm.addr(pk);
        require(c.yesCount <= c.seeded.length, "SEEDED_YES is more than SEEDED_COUNT");

        uint256 total = c.creatorStake + c.seeded.length * c.each;
        console2.log(factory.resolverOf(c.templateId).describe(c.params));
        uint64 lock = factory.resolverOf(c.templateId).validate(c.params).lock;
        console2.log("staking stops at (unix)", uint256(lock));
        console2.log("creator (deployer, ours) stakes YES, USDC", c.creatorStake / 1e6);
        for (uint256 i; i < c.seeded.length; ++i) {
            console2.log(i < c.yesCount ? "seeded stakes YES" : "seeded stakes NO", c.seeded[i], c.each / 1e6);
        }
        console2.log("USDC spent in all", total / 1e6);

        require(lock >= block.timestamp + MIN_LEAD, "staking stops in under 10 minutes: pick a later CLOSE or LOCK");
        uint256 balance = usdc.balanceOf(deployer);
        if (balance < total) {
            console2.log("USDC held by the deployer", balance / 1e6);
            revert("deployer holds too little USDC: send the difference to the deployer");
        }
        require(deployer.balance >= MIN_MON, "deployer holds under 1 MON for gas");

        vm.startBroadcast(pk);
        usdc.approve(factory.vault(), total);
        m = Market(payable(factory.createMarket(c.templateId, c.params, Side.Yes, c.creatorStake)));
        for (uint256 i; i < c.seeded.length; ++i) {
            m.stakeFor(c.seeded[i], i < c.yesCount ? Side.Yes : Side.No, c.each);
        }
        vm.stopBroadcast();

        (uint256 yesTotal, uint256 noTotal, uint32 stakers) = m.poolTotals();
        console2.log("market", address(m));
        console2.log("market id", m.marketId());
        console2.log("YES pool, USDC", yesTotal / 1e6);
        console2.log("NO pool, USDC", noTotal / 1e6);
        console2.log("stakers", uint256(stakers));
        console2.log("graduation rule met", m.graduationRuleMet());
    }

    /// Template 2 params for a Chainlink feed named in the deployments file (`external.chainlink`).
    function priceAtTimeParams(string memory pair, int256 strikeE8, uint64 lock, uint64 close)
        public
        returns (bytes memory)
    {
        if (bytes(json).length == 0) _load();
        PriceAtTimeParams memory p;
        p.source = SOURCE_CHAINLINK;
        p.feed = vm.parseJsonAddress(json, string.concat(".external.chainlink['", pair, "']"));
        p.strikeE8 = strikeE8;
        p.lockTime = lock;
        p.closeTime = close;
        return abi.encode(p);
    }

    function seededWallets() public returns (address[] memory) {
        if (bytes(json).length == 0) _load();
        return vm.parseJsonAddressArray(json, ".wallets.seeded");
    }

    function _load() internal {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/monad-mainnet.json"));
    }
}
