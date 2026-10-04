# Golden path: one market, start to finish, on Monad testnet

This is the walk-through for a person who wants to see every stage of a Hunch Book market with their
own eyes: stake into a pool, graduate it to a Kuru order book, trade YES and NO, settle it from
the chain, check the settlement, and redeem. It takes two browser wallets and about two and a half
hours, most of it waiting for the observation window.

Everything runs on Monad testnet with Hunch Book's own test USDC, which has no value. The app is
<https://book.playhunch.xyz>. Every transaction the app sends is listed under the button that sent it,
with a link to the explorer (<https://testnet.monadscan.com>).

## What is prepared for you

Graduation needs a pool of at least 500 USDC from at least 10 different wallets, with stakes on both
sides and a chance between 3% and 97% (docs/PROTOCOL.md §5.3). Ten wallets is a lot to ask of one
person, so Hunch Book prepares a market that is just short of the rule:

```
DEPLOYER_PRIVATE_KEY=... MONAD_TESTNET_RPC=... forge script script/GoldenPath.s.sol \
  --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 110
```

[`contracts/script/GoldenPath.s.sol`](../contracts/script/GoldenPath.s.sol) creates a Perpl MON
funding market (template 1) from Hunch Book's deployer wallet, then stakes from seven more wallets
derived from the same key, labelled "hunch-book testnet seed" exactly like the other seeding script.
**These eight stakes are ours**, and the app and this page say so. The pool ends at 480 USDC
(240 on YES, 240 on NO) from 8 stakers. Two outside wallets, yours, each staking at least 10 USDC
(one on YES, one on NO) complete the rule.

The script prints the market's address, its rule, its lock and close blocks with estimated times in
UTC and IST, and exactly what the two wallets must stake. Its options:

| Variable | Default | Meaning |
|---|---|---|
| `LOCK_AT_UNIX` | now | The lock (end of staking) comes after this unix time... |
| `MARGIN_MINUTES` | 60 | ...plus this margin, converted to a block with the measured block time and moved to the next funding event |
| `WINDOW_INTERVALS` | 2 | Funding intervals of 8,571 blocks in the observation window (2 is about 86 minutes) |
| `THRESHOLD_RAW` | from recent funding | The threshold in Perpl's raw units. By default the script picks the value past windows of the same length beat about half the time, and prints why |
| `SEED_STAKERS` | 8 | Stakers our wallets put in, the first stake included. The rest of the 10 are yours |
| `GAP_USDC` | 20 | How far short of 500 USDC the pool stops |
| `BLOCK_TIME_MS` | measured | Skip measuring the block time |

Without `--broadcast` it is a dry run: it prints the same report and sends nothing.

If you would rather start from nothing, the create flow at <https://book.playhunch.xyz/create> makes a
market from any template, and the rest of this walk-through is the same. You then need ten stakers
yourself.

## You need

- Two wallets, called A and B below. Two accounts in one browser wallet (MetaMask, Rabby or any wallet
  that announces itself) work; so do two browsers.
- The market address the script printed. Open `https://book.playhunch.xyz/m/<address>`.
- About 15 minutes before the lock block to stake, then time for the window to pass.

## 1. Add Monad testnet

**Do:** open the app and click **Connect wallet** (top right). Pick your wallet. If it is on another
network, the app shows **Switch to Monad testnet**: click it and approve both prompts in the wallet.

**You should see:** your short address in the header, and no network warning.

**Behind it:** the app asks the wallet to add the chain (`wallet_addEthereumChain`: chain id 10143,
RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadscan.com`) and to switch to it.
No transaction.

Do this for wallet A and wallet B.

## 2. Get MON for gas

**Do:** open <https://faucet.monad.xyz> and request testnet MON for wallet A and for wallet B. The
app links there from its faucet buttons too ("Get testnet MON for gas").

**You should see:** a MON balance in your wallet. A few tenths of a MON cover everything below.

## 3. Get test USDC in the app

**Do:** click your address in the header. Under **Testnet funds**, click **Get 1,000 test USDC** and
confirm in the wallet. Repeat with wallet B.

**You should see:** the transaction listed as confirmed with an explorer link, and the balance shown
in the stake ticket ("Wallet 1,000.00 USDC").

**Transaction:** `TestUSDC.mint(you, 1000000000)` on the test USDC contract (the address is
`hunchBook.usdc` in [deployments/monad-testnet.json](../deployments/monad-testnet.json)). Anyone can
mint up to 10,000 test USDC per call.

## 4. Stake from wallet A

**Do:** with wallet A connected, open the market page. In the **Ticket**, keep the **Stake** tab,
pick **YES**, type **10** (or the amount the script printed). The first time, the button reads
**Step 1 of 2: approve USDC**: click it and confirm. Then click **Stake 10.00 USDC on YES** and confirm.

**You should see:** the payout preview (what YES pays if it wins, after the 2% fee on winnings), then
the pool at 490.00 USDC with 9 stakers, and your stake under **Your position**.

**Transactions:**

1. `USDC.approve(vault, max)`: one approval lets the Hunch Book vault pull USDC for any stake in any
   market. You can revoke it from your wallet.
2. `Market.stake(0, 10000000)`: side 0 is YES. Stakes are final: a pool has no withdrawal.

## 5. Stake from wallet B, and the rule is met

**Do:** switch to wallet B (in the wallet, or with **Connect wallet**). On the same page, pick **NO**,
type **10**, approve, then **Stake 10.00 USDC on NO**.

**You should see:** the pool at 500.00 USDC with 10 stakers, YES and NO at 250.00 USDC each, an
implied chance of 50.0%, and every line of the **Graduation rule** panel in lime with "Met".

**Transactions:** the same two as wallet A, with side 1 (NO).

## 6. Graduate the pool to Kuru

**Do:** in the **Actions** panel, click **Graduate to Kuru** and confirm. Hunch Book's keeper
watches every pool and may graduate it first, within a minute or so; the page then simply moves on.

**You should see:** the phase badge changes from **Pool** to **Trading**, the chance now comes from
the mid price of the book, and the market shows its Kuru YES/USDC book address.

**Transaction:** `Market.graduate()`. In one transaction the pool's 500 USDC becomes 500 YES and 500
NO tokens held by the vault for the stakers, and the Graduator creates the market's YES/USDC book on
Kuru at the pool's price (50%). The redemption fee per winning token is fixed now: 0.02 × 250 / 500
= 0.01 USDC.

## 7. Claim your tokens

**Do:** with each wallet, click **Claim tokens** in **Actions**. If the keeper already pushed the
claims, the button says there is nothing to claim and the tokens are already in your wallet.

**You should see:** under **Your position**, wallet A holds 20 YES and wallet B holds 20 NO. Each
staker gets the pool total times their share of their side: 500 × 10 / 250 = 20.

**Transaction:** `Market.claimTokens()` (or the keeper's `claimTokensFor([...])` for everyone).

Holding these tokens to the end pays exactly what the pool would have paid: if YES wins, wallet A
redeems 20 × 0.99 = 19.80 USDC, the same as the pool payout 10 + 0.98 × 10 × 250 / 250.

## 8. Buy and sell YES and NO

**Do:** open the **Trade** tab of the ticket. Try each of the four:

- **Buy YES**: spend a few USDC on YES at the asks.
- **Sell YES**: sell some YES into the bids.
- **Buy NO**: receive NO tokens; the router mints YES and NO from your USDC and sells the YES.
- **Sell NO**: sell NO; the router buys YES and merges the pairs back into USDC.

Each trade shows its quote, the price you pay or get, and a slippage limit. The first time for each
token the button reads **Step 1 of 2: approve ...**: the router is approved for exactly that trade
and no more. Then click **Buy YES** (or the trade you chose) and confirm.

**You should see:** the order book update, your token balances change, and each transaction listed
with its explorer link.

**Transactions:** `approve(router, amount)` on USDC, YES or NO as needed, then one of
`HunchRouter.buyYes`, `sellYes`, `buyNo` or `sellNo`, each with a minimum out (or maximum in) and a
deadline.

Trades need someone on the other side of the book. On testnet, Hunch Book's own maker bot quotes
graduated books, and its fills are labelled as ours on the proof page. If the ticket says "no asks"
or "no bids", wait a minute for the bot's quotes, or use **Mint sets** and **Merge sets** in
**Actions**, which work without a book: 1 USDC makes 1 YES and 1 NO, and 1 YES and 1 NO merge back
into 1 USDC.

## 9. Wait for the close

**You should see:** the **Timeline** panel counts down to the lock block and then the close block.
These markets run on block numbers, so the times next to them are estimates from the chain's recent
pace. After the close block the phase reads **Closed**: the router refuses trades and settlement
opens.

## 10. Settle

**Do:** in **Actions**, the **Settle** button turns on once the close block has passed. The app first
asks the resolver what it would answer and shows it ("The resolver answers YES with this evidence").
Click **Settle** and confirm. The keeper settles markets too, so it may already be done.

**You should see:** the phase badge reads **Settled**, and the chance panel shows the winning side,
YES or NO.

**Transaction:** `Market.settle(0x)`. Perpl markets settle with empty evidence: the resolver reads
Perpl's `getFundingSumAtBlock` at the start and end blocks itself. YES if the funding paid by longs
over the window is more than the threshold; equal is NO. Nobody, including Hunch Book, can choose
the answer.

## 11. Open the verifier and re-run the read

**Do:** follow the **verify page** link under **Settle** (or open `/verify/<address>`). Click
**Re-run this read from your browser**. No wallet is needed.

**You should see:** the contract and function that were read (Perpl's Exchange,
`getFundingSumAtBlock`), the perp, the start and end blocks, the two funding sums, ΔF = F(end) − F(start),
the threshold, the outcome from the read, and the evidence hash rebuilt from those values matching
the one the market stored.

**Behind it:** plain `eth_call`s from your browser to the Monad RPC. No transaction.

## 12. Redeem

**Do:** with the winning wallet, click **Redeem tokens** in **Actions** and confirm.

**You should see:** your winning tokens gone and USDC in your wallet at 0.99 per token. Losing tokens
redeem for nothing, so the button explains that instead.

**Transaction:** `CollateralVault.redeem(market, side, amount, you)`.

## 13. Check the portfolio

**Do:** open **Portfolio** in the header.

**You should see:** every market the wallet touched, with its stake, tokens and anything still to
claim or redeem. **Claim all and redeem all** does what is left in one go.

## 14. Hard refresh

**Do:** press Cmd+Shift+R (Ctrl+Shift+R on Windows and Linux) on the market page, the verify page and
the portfolio.

**You should see:** the same phase, outcome, balances and history as before. The app keeps nothing
of its own: every number comes back from the chain, and the wallet reconnects by itself.

## Transactions, in order

| Step | Wallet | Call |
|---|---|---|
| Setup (ours) | deployer | `TestUSDC.mint`, `approve(vault)`, `HunchBookFactory.createMarket(1, params, YES, 60 USDC)`, 7 × `Market.stakeFor(seed, side, 60 USDC)` |
| 3 | A, B | `TestUSDC.mint(you, 1,000 USDC)` |
| 4 | A | `USDC.approve(vault, max)`, `Market.stake(YES, 10 USDC)` |
| 5 | B | `USDC.approve(vault, max)`, `Market.stake(NO, 10 USDC)` |
| 6 | anyone | `Market.graduate()` |
| 7 | A, B (or the keeper) | `Market.claimTokens()` (or `claimTokensFor`) |
| 8 | A, B | `approve(router, amount)`, `HunchRouter.buyYes` / `sellYes` / `buyNo` / `sellNo` |
| 10 | anyone (or the keeper) | `Market.settle(0x)` |
| 12 | the winner | `CollateralVault.redeem(market, side, amount, you)` |
