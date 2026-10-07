# Hunch Book TypeScript SDK

Status: **building**. The SDK is in [`packages/sdk`](../packages/sdk) (`@hunch-book/sdk`). It reads the
contracts live on Monad testnet and is tested end to end against the real contracts on a local chain.
It is used from this repository's pnpm workspace. It is ready to publish (packed, installed and
imported from its tarball in CI, [RELEASE.md](./RELEASE.md)) and not on npm yet.

It is a thin, typed layer over [viem](https://viem.sh) and the shared package
([`packages/shared`](../packages/shared)): the same ABIs (generated from the contracts), the same
template codecs, the same quote math (HunchRouter's and Kuru's integer arithmetic) and the same
evidence hashes. Addresses come only from `deployments/<network>.json`. The SDK holds no keys: writes
are signed by a viem wallet client you pass in.

## Contents

- [Set up a client](#set-up-a-client)
- [Read markets](#read-markets)
- [Quote trades](#quote-trades)
- [Send actions](#send-actions)
- [Stake without gas: signed USDC authorisations](#stake-without-gas-signed-usdc-authorisations)
- [Settle any market](#settle-any-market)
- [Verify a settlement](#verify-a-settlement)
- [Periphery](#periphery)
- [Reward trees](#reward-trees)
- [Errors](#errors)
- [Units and JSON](#units-and-json)
- [Tests](#tests)

## Set up a client

```ts
import { createHunchClient } from "@hunch-book/sdk";

const hunch = createHunchClient({ network: "monad-testnet" });
```

| Option | Default | What it does |
|---|---|---|
| `network` | `"monad-testnet"` | `"monad-testnet"` or `"monad-mainnet"`. Picks `deployments/<network>.json` and the chain. |
| `publicClient` | made from `rpcUrl` or the deployment's `rpc` | Every read goes through it. |
| `walletClient` | none | A viem wallet client with an account. Without it the client is read-only and actions throw. |
| `rpcUrl` | the deployment's `rpc` | RPC for the public client the SDK makes. |
| `pyth` | none | `{ apiKey, hermesUrl?, fetch? }`: lets settlement fetch signed Pyth updates from Hermes for price markets with a Pyth source. |
| `deployment`, `chain`, `multicallAddress` | from the network | Overrides for a local chain in tests. |

A wallet client, with the key read from your environment:

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHunchClient, monadTestnet } from "@hunch-book/sdk";

const account = privateKeyToAccount(process.env.MY_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http() });
const hunch = createHunchClient({ network: "monad-testnet", walletClient });
```

Every function on the client also exists on its own, taking a context first, so a bundler keeps only
what you import (`sideEffects: false`):

```ts
import { createContext, listMarkets, quote } from "@hunch-book/sdk";
const ctx = createContext({ network: "monad-testnet" });
const page = await listMarkets(ctx, { limit: 20 });
```

## Read markets

| Call | Returns |
|---|---|
| `hunch.markets.count()` | how many markets the factories have created (every stack) |
| `hunch.markets.list({ offset, limit, order })` | a page of `MarketInfo`, newest first by default (at most 200 per page); with several stacks, the primary stack's markets come first, then each extra stack's |
| `hunch.markets.all()` | every market, read in pages |
| `hunch.markets.get(address)` | one `MarketInfo`, or `null` if no factory knows the address (every stack's `isMarket` is checked first) |
| `hunch.markets.book(market)` | the Kuru book: every level from `getL2Book()`, the matching params, mid, spread, depth (Kuru v1 or v2, from the market's stack) |
| `hunch.markets.position(market, user)` | stakes, claimable tokens, claimable pool payout, YES and NO balances |
| `hunch.markets.portfolio(user)` | positions in every market that has something in it |

`MarketInfo` holds, for one market in one Multicall3 pass:

- `id`, `templateId`, `template` ("Perpl net funding"), `phase` with `phaseName` (`pool`, `pool-locked`,
  `trading`, `closed`, `settled`, `voided`) and `phaseLabel`, `outcome` with `outcomeLabel`;
- `rule`: the resolver's own `describe()` sentence, the rule of record;
- `decoded`: the params decoded for templates 1 to 7 (`perpl-funding`, `price-at-time`,
  `chainlink-touch`, `perpl-funding-spike`, `price-range`, `parlay`, `snapshot`), and `asset` ("BTC",
  "BTC/USD") from the deployments file, or for a snapshot market from its source (`snapshotSource`:
  the resolver's label, unit and decimals for the value it reads);
- `pool` (`yes`, `no`, `total` in USDC base units, `stakers`), `window` (`blockClock`, `lock`, `close`,
  `settleDeadline`), `tokens`, `book`, `resolver`, `creator`, `graduationRule`,
  `graduationRuleMet`, `caps`, `evidenceHash`;
- `prices`: the YES book's best bid and ask in USDC base units per token (E6), null where a side is empty;
- `stack` and `kuruVersion` for a market on an extra stack (absent: the primary stack on Kuru v1). Each
  stack has its own vault and router; `stake`, `trade`, `mintSets`, `mergeSets` and `redeem` use the
  market's own, and `createMarket` takes `{ stack }` (default the primary stack). On a Kuru v2 book the
  matching params carry `takerFeePps` (parts per 10^7), which selects v2 matching in quotes;
- `chance`: `{ bps, source }`. Pool phase: `Y / T`. Trading: the book's mid, or the one side's price
  when the other is empty (as the onchain ImpliedProbabilityOracle reads it). Settled: 100% or 0%.
  Voided: 50%.

## Quote trades

```ts
const q = await hunch.quotes.buyYes(market, parseUsdc("25"), { slippageBps: 100n });
q.tokens;        // YES received
q.usdc;          // USDC spent
q.avgPriceE6;    // average price, E6
q.limit;         // the router's minYesOut after 1% slippage
q.approval;      // { token: "usdc", amount }: what the router must be allowed to pull
q.impactBps;     // how much worse than the mid
q.shortfall;     // null, or "empty" | "liquidity" | "dust" | "price"
```

The four kinds follow HunchRouter (docs/PROTOCOL.md §5.4): `buyYes(usdcIn)`, `sellYes(yesIn)`,
`buyNo(noOut)` (mint sets, sell the YES), `sellNo(noIn)` (buy YES, merge). The numbers equal what the
router would do against the book that was read. `maxAmount(book, kind, balances)` gives the largest
amount the balances and the book allow.

## Send actions

Every action simulates first, with every Hunch Book error attached, so a revert comes back as a plain
sentence before anything is signed. It then sends, waits for the receipt and returns
`{ hash, url, status, blockNumber, result, receipt }`. `url` is the explorer link. Pass
`{ wait: false }` to return as soon as the transaction is sent.

| Call | What it does |
|---|---|
| `actions.createMarket({ templateId, params, side, firstStake })` | `params` as typed fields (encoded canonically, parlay legs sorted) or as bytes. Throws with the existing market's address if the question exists. Approves the vault for the stake if needed. Returns `market`. |
| `actions.stake(market, side, amount)` | approves the vault once if needed, then stakes |
| `actions.graduate(market)` | graduates a pool that meets its rule |
| `actions.claimTokens(market)`, `claimTokensFor(market, users)` | token claims after graduation |
| `actions.trade(market, kind, amount, { slippageBps, deadlineSeconds })` | quotes, refuses a trade the book cannot fill, approves the router for the exact input, and sends with the limit and a deadline (default 120 seconds) |
| `actions.mintSets(market, amount)`, `mergeSets(market, amount)` | complete sets on the vault |
| `actions.settle(market)` | finds the evidence (below) and settles; `{ evidence, value }` to pass your own |
| `actions.proveYes(market)` | touch templates: proves YES before close with the proof it finds |
| `actions.takeSnapshot(market)` | template 7: takes the snapshot inside its window without settling (`settle` takes it too when nobody has) |
| `actions.voidIfExpired(market)` | after the settlement deadline |
| `actions.redeem(market, side, { amount, to })` | redeems the winning side (or either side after a void) |
| `actions.claimPool(market)` | a pool-only market's payout or refund |
| `actions.collect(market)` | everything to get a finished market's USDC out: claims tokens, claims the pool payout, redeems |
| `actions.collectAll(markets, { mode })` | `collect` across many markets. With `mode: "auto"` (the default) it sends one atomic batch when the wallet supports EIP-5792 `wallet_sendCalls` on this chain (one confirmation; all land or none do), and one transaction at a time otherwise; `"atomic"` requires the batch, `"sequential"` never batches. Returns `{ mode, calls, transactions }` |
| `actions.planCollect(markets, owner?)` | the calls `collectAll` would send, with a label each, without sending anything |
| `actions.sendCalls(calls, { mode })`, `actions.canBatchAtomically()` | any list of calls, batched the same way, and whether this wallet can batch |
| `actions.withdrawCreatorFees()` | the creator's 25% share of fees |
| `actions.mintTestUsdc(amount)` | testnet only: the test USDC faucet, at most 10,000 per call |

Sides are `"yes"`, `"no"` or `Side.Yes`, `Side.No`. Amounts are base units: `parseUsdc("12.5")`.

## Stake without gas: signed USDC authorisations

A user signs; a relayer pays the gas (docs/PROTOCOL.md §9.5). The signed USDC `receiveWithAuthorization`
(EIP-3009) pays exactly that amount to that market, for that side only: its nonce is
`keccak256(abi.encode(chainid, market, user, side, salt))`, so a relayer cannot move it elsewhere.

```ts
// On the user's side:
const auth = await user.actions.buildStakeAuthorization({ market, user: me, side: "yes", amount: parseUsdc("10") });
const signed = await user.actions.signStakeAuthorization(auth); // or sign auth.typedData yourself

// On the relayer's side:
await relayer.actions.stakeWithAuthorization(signed);
```

`auth.typedData` is ready for any EIP-712 signer (`signTypedData`), with the domain read from the USDC
contract (`name()`, `version()`).

## Settle any market

`hunch.settlement.plan(market)` finds the evidence a market needs, then runs the market's resolver as a
call from the market's own address with it, so the plan says exactly what settling now would store.

```ts
const plan = await hunch.settlement.plan(market);
switch (plan.status) {
  case "ready":   // plan.method ("settle" or "proveYes"), plan.evidence, plan.value, plan.outcome, plan.evidenceHash
  case "wait":    // plan.reason: what it is waiting for
  case "blocked": // plan.reason: the resolver refuses this evidence, or a Pyth update cannot be fetched
  case "expired": // past the deadline: voidIfExpired
  case "final":   // already settled or voided
}
```

| Template | Evidence the SDK finds |
|---|---|
| 1, Perpl net funding | empty, once `block.number > endBlock` |
| 2, price at a time; 5, price range | Chainlink: the one round that brackets the close (`updatedAt(r) <= T < updatedAt(r + 1)`, same phase, at most an hour old), found by galloping back from the latest round and narrowing with batched reads. Pyth: the first signed update at or after T from Hermes (needs `pyth.apiKey`), sent with Pyth's fee as `value` |
| 3, price touch | YES: the first round in the window that is answered in itself, positive, and at or past the strike, rounded the resolver's way (truncated for "at or above", rounded up for "at or below"); `proveYes` before close. NO: empty, once the 24-hour challenge period after the window is over |
| 4, Perpl funding spike | YES: a single funding event in the window whose increment is above the threshold. Read on Perpl's fixed grid in one batch; if any event is off the grid, it walks back one event at a time so none is missed. NO: empty, once `block.number > endBlock + challengeBlocks` |
| 6, parlay | empty, once any leg is NO or every leg is YES |
| 7, snapshot | empty. Before the window: wait. Inside [closeTime, closeTime + snapshotWindow]: `settle` takes the snapshot and settles in one transaction (the dry run does the same read, so a source that fails a check reads as wait). With a snapshot stored: settles from it, any time up to the deadline. After the window with none: blocked, the market voids at its deadline |

`actions.settle(market)` runs the plan and sends `settle` (or `proveYes`) only when it is `ready`.

## Verify a settlement

`hunch.settlement.verify(market)` checks a settlement from the chain alone, with no trust in the
settler, the keeper or this SDK:

1. It does the resolver's reads again with a plain public client.
2. It rebuilds the evidence hash from those values (each format is in [TEMPLATES.md](./TEMPLATES.md))
   and compares it with the hash the market stored.
3. It runs the resolver again as a call with the same evidence and compares outcome and hash.

```ts
const v = await hunch.settlement.verify(market);
v.verified;            // true: the stored hash is reproduced from the source
v.matches;             // { evidenceHash, outcome, rerun }
v.recomputed.reads;    // what was read: rounds, funding sums, legs
v.notes;               // anything worth knowing, in plain words
```

Notes per template: a touch market that settled NO stores the feed's latest round at settlement, so the
SDK finds the settlement block (searching `phase()` at past blocks, or from `settlementBlock` if you pass
it) and reads that round there. A touch or spike market that settled NO while a touching round or a
spike existed is flagged (nobody proved it during the challenge period). A Pyth settlement is checked by
re-running the resolver with the signed update from the settlement transaction. A snapshot market
(template 7) is checked against its stored snapshot: the hash is rebuilt from the source's call, word,
value, block and time (the shared `snapshotEvidenceHash`), and the source call is made again at the
snapshot's block and read the resolver's way (`snapshotValueFromReturnData`); a re-read that differs
is flagged, since a later transaction in the same block can move the value. For a market that has
not settled, `verify` returns `status: "open"` and the settlement `plan`.

## Periphery

[PERIPHERY.md](./PERIPHERY.md) describes each contract.

| Call | What it does |
|---|---|
| `periphery.autoRedeem.set(true)` | opts in to auto-redeem everywhere |
| `periphery.autoRedeem.optInWithPermit({ token, value })` | signs an EIP-2612 permit on an outcome token and opts in, in one transaction |
| `periphery.autoRedeem.setMarketOptOut(market, true)`, `approve(token, amount)`, `redeemable(market, holder)` | |
| `periphery.orders.place({ market, kind, condition, triggerPriceE6, expiry, executorTipBps, amountIn, limit })` | approves what the order will pull, then places it. `conditionFor("take-profit")` gives the condition for a style |
| `periphery.orders.cancel(id)`, `execute(id)`, `get(id)` | `execute` earns the order's tip |
| `periphery.referrals.bind(referrer)` | binds the wallet for the registry's duration (180 days on testnet) |
| `periphery.referrals.build({ user, referrer })`, `sign(binding)`, `bindFor(signed)` | the EIP-712 `Bind` message a user signs and a relayer submits |
| `periphery.referrals.of(user)` | the binding and whether it is active |
| `periphery.rewards.claim(claim)`, `claimMany(claims)`, `isClaimed(epoch, account)`, `nextEpoch()` | MerkleDistributor claims; the USDC always goes to the account in the leaf |
| `periphery.oracle.chance(market)`, `twap(market, seconds)`, `poke(market)` | the ImpliedProbabilityOracle |

## Reward trees

```ts
import { buildRewardTree, mergeClaims, verifyRewardProof } from "@hunch-book/sdk";

const epoch = await hunch.periphery.rewards.nextEpoch();
const tree = buildRewardTree(epoch, mergeClaims(claims)); // { root, total, claims: [{ account, amount, leaf, proof }] }
```

The leaf is `keccak256(bytes.concat(keccak256(abi.encode(uint256 epoch, address account, uint256 amount))))`
and the tree is OpenZeppelin's StandardMerkleTree layout, so roots and proofs equal what
`@openzeppelin/merkle-tree` builds (a test checks this for 1 to 40 leaves) and what MerkleDistributor
verifies (the integration test pays an epoch). Build each epoch with the id `nextEpoch()` returns, with
each account once. The rewards service ([REWARDS.md](./REWARDS.md)) writes epoch files with it.

## Errors

Every action throws a `HunchError` whose `message` is one plain sentence and whose `code` is the
contract's error name, with the original error as `cause`:

```ts
try {
  await hunch.actions.stake(market, "yes", parseUsdc("2000"));
} catch (e) {
  // "That stake would take this wallet over the market's limit." (code "WalletCapExceeded")
}
```

`describeError(e)` gives the sentence for any error, `decodeRevert(data)` decodes raw revert data, and
`KNOWN_ERRORS_ABI` lists every error of the core, the seven resolvers, the periphery, Kuru and the test USDC.

## Units and JSON

USDC and outcome tokens use 6 decimals. `parseUsdc("12.5")` is `12500000n`; `formatUsdc(12500000n)` is
`"12.5"`. Prices ending in `E6` are USDC base units per whole token. `toJsonSafe(value)` turns bigints
into strings, for HTTP responses and agents.

## Tests

```sh
pnpm --filter @hunch-book/sdk test
```

- Unit tests run every read, quote, action and settlement path against a fake chain behind viem's custom
  transport (contracts are ABIs with handlers; Multicall3 is decoded and dispatched; signed transactions
  are decoded and recorded), and check the evidence hashes against encodings written out from
  TEMPLATES.md.
- The integration suite starts anvil and deploys, from `contracts/out`, the real factory, vault, markets,
  outcome tokens, the seven real resolvers (reading mock Chainlink, Perpl and snapshot sources), the
  distributor, the referral registry and the auto-redeemer. It creates a market on every template, stakes
  directly and through a relayed USDC authorisation, graduates, claims, mints and merges, settles every
  template with the evidence the SDK finds (YES and NO for touch and spike markets; a snapshot taken by
  `settle` and one taken by `takeSnapshot`, with two markets sharing one), and checks that `verify`
  reproduces the hash each real resolver stored. It also pays a reward epoch built with
  `buildRewardTree`, binds a referral from a signature and opts in to auto-redeem with a permit. It skips
  when anvil or `contracts/out` is missing: run `forge build` in `contracts/` first.
