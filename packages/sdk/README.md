# @hunch-book/sdk

TypeScript SDK for Hunch Book, built on [viem](https://viem.sh). Read markets, quote trades against the
live order book (Hunch Book's own, or Kuru's: each market's `venue` says which), send every lifecycle action, find settlement evidence for templates 1 to 7, verify any
settlement from the chain alone, use the periphery contracts, and build reward trees.

Status: **building**. It runs against the contracts live on Monad testnet and is tested end to end
against the real contracts on a local chain. It is ready to publish to npm and not on npm yet
([RELEASE.md](https://github.com/rajkaria/hunch-book/blob/main/docs/RELEASE.md)). The full guide is [docs/SDK.md](https://github.com/rajkaria/hunch-book/blob/main/docs/SDK.md).

## Quick start

```ts
import { createHunchClient, formatBps, formatUsdc, parseUsdc } from "@hunch-book/sdk";

// Read-only: no wallet, no key.
const hunch = createHunchClient({ network: "monad-testnet" });

const { markets } = await hunch.markets.list({ limit: 10 });
for (const m of markets) {
  console.log(`#${m.id} ${m.phaseLabel} ${formatBps(m.chance.bps) ?? "n/a"} ${m.rule}`);
}

const market = markets[0];
const quote = await hunch.quotes.buyYes(market, parseUsdc("10"));
console.log(`10 USDC buys ${formatUsdc(quote.tokens)} YES, ${quote.impactBps} bps from the mid`);
```

With a wallet (read the key from your environment, never from code):

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHunchClient, monadTestnet, parseUsdc } from "@hunch-book/sdk";

const account = privateKeyToAccount(process.env.MY_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http() });
const hunch = createHunchClient({ network: "monad-testnet", walletClient });

await hunch.actions.mintTestUsdc(parseUsdc("100")); // testnet faucet
const tx = await hunch.actions.trade(market, "buyYes", parseUsdc("10"), { slippageBps: 100n });
console.log(tx.url); // the explorer link
```

Settle any market whose answer is in, with the evidence found for you:

```ts
const plan = await hunch.settlement.plan(market);
if (plan.status === "ready") await hunch.actions.settle(market);
const check = await hunch.settlement.verify(market); // check.verified === true
```

## What is in it

| Area | Functions |
|---|---|
| Markets | `list`, `all`, `get`, `book`, `position`, `portfolio`, decoded params for templates 1 to 7, the resolver's rule sentence, phase, pool totals, best prices, implied chance |
| Quotes | `buyYes`, `sellYes`, `buyNo`, `sellNo` against the live L2 book, with the slippage limit, the approval needed, price impact, touch price and `maxAmount` |
| Actions | `approve`, `createMarket`, `stake`, `buildStakeAuthorization` + `signStakeAuthorization` + `stakeWithAuthorization` (gasless staking), `graduate`, `claimTokens`, `trade`, `mintSets`, `mergeSets`, `settle`, `proveYes`, `voidIfExpired`, `redeem`, `claimPool`, `collect`, `withdrawCreatorFees`, `mintTestUsdc` |
| Settlement | `plan` (evidence, method and dry-run outcome for templates 1 to 7), `verify` (rebuild the evidence hash and re-run the resolver), `findTransaction` |
| Periphery | auto-redeem opt-in (with an EIP-2612 permit), conditional orders, referral binding (with an EIP-712 signature), reward claims, the implied-probability oracle |
| Rewards | `buildRewardTree` (matches OpenZeppelin's StandardMerkleTree and the MerkleDistributor leaf), `verifyRewardProof`, `mergeClaims` |
| Errors | every revert decoded to one plain sentence (`HunchError`, `describeError`) |

Every function is also exported on its own, taking a context first, so a bundler keeps only what you use:

```ts
import { createContext, getMarket, planSettlement } from "@hunch-book/sdk";
const ctx = createContext({ network: "monad-testnet" });
const plan = await planSettlement(ctx, "0x2A44B99014cF73065BFb89197a08DE09D18d3982");
```

## Tests

```sh
pnpm --filter @hunch-book/sdk test
```

Unit tests run every read, quote, action and settlement path against a fake chain behind viem's
custom transport. The integration suite (`test/integration/`) starts anvil, deploys the real factory,
vault, markets, seven resolvers (on mock Chainlink, Perpl and snapshot sources), distributor, referral registry and
auto-redeemer from `contracts/out`, and runs every template from creation to a verified settlement. It
skips when anvil or `contracts/out` is missing; run `forge build` in `contracts/` first.
