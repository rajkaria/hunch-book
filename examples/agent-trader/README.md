# agent-trader

A small agent on [`@hunch-book/sdk`](../../packages/sdk). Every minute it reads each trading Perpl
funding market (template 1), estimates the chance that funding over the market's window ends above the
threshold, and buys YES when the book's ask is cheap enough, within a budget.

**Dry run by default**: it prints what it would buy and sends nothing. It is an example of wiring the
SDK together, with a deliberately simple model, not trading advice.

## How it decides

For each market (all in [`src/strategy.ts`](./src/strategy.ts), pure and tested):

1. **Funding so far.** `F(now) − F(startBlock)` from Perpl's `getFundingSumAtBlock`, through the SDK's
   `fundingAt`.
2. **Forecast.** The average funding of the last 6 events, times the events left before `endBlock`, plus
   what was paid so far. The error is normal, sized from the spread of the last 48 events and growing
   with the square root of the events left.
3. **Chance of YES.** `P(funding > threshold)`, with equal counting as NO, as the resolver rules.
4. **Trade.** If the chance beats the best ask by at least `AGENT_MIN_EDGE`, it quotes the buy against
   the live book, checks the fill's average price still leaves half that edge, and buys YES through the
   router with a slippage limit, at most `AGENT_MAX_TRADE_USDC` per trade and `AGENT_BUDGET_USDC` in
   total.

## Run

```sh
pnpm install
pnpm --filter "@hunch-book/sdk..." build           # the SDK and the shared package
pnpm --filter @hunch-book/example-agent-trader once  # one pass, dry run
pnpm --filter @hunch-book/example-agent-trader start # every minute, dry run
```

To trade on testnet, use a wallet made for the agent with test USDC and a little MON for gas:

```sh
AGENT_LIVE=1 AGENT_PRIVATE_KEY=... pnpm --filter @hunch-book/example-agent-trader start
```

| Variable | Default | What it does |
|---|---|---|
| `AGENT_NETWORK` | `monad-testnet` | or `monad-mainnet` |
| `AGENT_RPC_URL` | the deployment's RPC | |
| `AGENT_LIVE` | off | `1` sends trades; anything else is a dry run |
| `AGENT_PRIVATE_KEY` | none | needed only with `AGENT_LIVE=1` |
| `AGENT_BUDGET_USDC` | `20` | total USDC the agent may spend in one run |
| `AGENT_MAX_TRADE_USDC` | `5` | USDC per trade |
| `AGENT_MIN_EDGE` | `0.05` | the chance must beat the ask by this much (5 cents per YES) |
| `AGENT_SLIPPAGE_BPS` | `100` | slippage allowance per trade |
| `AGENT_INTERVAL_SECONDS` | `60` | time between passes |

## Tests

```sh
pnpm --filter @hunch-book/example-agent-trader test
```
