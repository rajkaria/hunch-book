# Hunch Book MCP server

Status: **building**. The server is in [`packages/mcp`](../packages/mcp) (`@hunch-book/mcp`). It runs on
your machine over stdio, on Monad testnet by default, and reads the markets live there. It is built on
the [TypeScript SDK](./SDK.md) and the official MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.0).

With it, an agent (Claude Desktop, Claude Code, or any MCP client) can find markets, read their exact
rules, quote, trade, stake, create markets, settle them with evidence found automatically, collect
winnings, and check any settlement from the chain, using its own wallet.

## Safety model

- **Read-only by default.** Without `HUNCH_MCP_PRIVATE_KEY` the server offers only the read tools.
  Write tools are not even listed.
- **Testnet by default.** On mainnet, write tools stay off unless `HUNCH_MCP_ALLOW_MAINNET_WRITES=1`.
- **Limits per call**, checked before anything is signed: USDC per stake, buy or first stake
  (`HUNCH_MCP_MAX_USDC_PER_CALL`, default 100), tokens per sell (`HUNCH_MCP_MAX_TOKENS_PER_CALL`,
  default 200), and slippage (`HUNCH_MCP_MAX_SLIPPAGE_BPS`, default 300). A `buyNo` is capped by the
  most it can cost.
- **Every write is simulated first.** A call that would revert returns the reason in plain words and
  sends nothing. A settle whose answer is not in yet says what it is waiting for.
- **Every write returns its explorer link.**
- The key is read from the environment by name only. It is never logged, never returned by a tool, and
  never part of an error message. Use a wallet made for the agent, funded with what you are ready to lose.

## Tools

Amounts go in and come out as decimal strings: `"12.5"` is 12.5 USDC (or 12.5 tokens).

| Tool | Kind | What it does |
|---|---|---|
| `status` | read | network, mode (read-only or the wallet), limits, contract addresses, the seven templates |
| `list_markets` | read | markets newest first, filtered by `phase`, `template` or `asset`: rule sentence, phase, chance of YES, pool, best prices, window |
| `get_market` | read | one market in full, what settling it would take now, and the wallet's position |
| `quote` | read | a trade quoted against the live book, as the router would fill it: pay, get, average price, impact, the limit |
| `get_portfolio` | read | a wallet's stakes, tokens and claims across markets (default: the server's wallet) |
| `verify_settlement` | read | rebuilds a settled market's evidence hash from the source and re-runs the resolver; `verified: true` means the stored outcome is reproduced |
| `create_market` | write | a market from template 1 to 7 with JSON params, plus the creator's first stake |
| `stake` | write | USDC on YES or NO in a pool |
| `trade` | write | `buyYes` (amount = USDC), `sellYes` (YES), `buyNo` (NO to receive), `sellNo` (NO) through the router, with a slippage limit |
| `settle` | write | settles with the evidence the SDK finds; a touch proved before close goes through `proveYes` |
| `redeem` | write | collects a finished market: claims tokens, claims the pool payout, redeems winners |
| `redeem_all` | write | collects every settled or voided market in the wallet's portfolio, in one atomic batch where the wallet supports EIP-5792 and one transaction at a time otherwise |
| `get_test_usdc` | write | testnet only: mints test USDC to the server's wallet |

Resources (Markdown): `docs://hunch-book/protocol`, `docs://hunch-book/templates`,
`docs://hunch-book/periphery`, `docs://hunch-book/sdk`.

### create_market params

| Template | Params |
|---|---|
| 1 Perpl net funding | `perpId`, `startBlock`, `endBlock`, `threshold` (raw funding units), `expectedScalingExp` |
| 2 price at a time | `source` (`"chainlink"` with `feed`, or `"pyth"` with `pythId`), `strikeE8` (USD x 1e8), `lockTime`, `closeTime` (unix seconds) |
| 3 price touch | `feed`, `strikeE8`, `direction` (`"atOrAbove"` or `"atOrBelow"`), `lockTime`, `startTime`, `endTime` |
| 4 Perpl funding spike | as template 1; `threshold` is for one funding event |
| 5 price range | as template 2, with `lowerE8` and `upperE8` |
| 6 parlay | `legs` (2 to 5 market addresses), `lockTime`, `closeTime` |
| 7 snapshot | `sourceId` (an id from the resolver's source list), `threshold` (raw units), `comparator` (`"above"`, `"atOrAbove"`, `"below"` or `"atOrBelow"`), `lockTime`, `closeTime`, `snapshotWindow` (60 to 1,800 seconds, default 600) |

Numbers may be strings. [TEMPLATES.md](./TEMPLATES.md) has every rule and creation check; the
resolver checks the params again when the market is created, and a refusal comes back in plain words.

## Install

From a checkout of this repository (Node 22 or later, pnpm 10):

```sh
pnpm install
pnpm --filter "@hunch-book/mcp..." build   # builds shared, the SDK and the server
node packages/mcp/dist/main.js             # prints one line on stderr, then waits for a client
```

Use the absolute path to `packages/mcp/dist/main.js` in the snippets below.

## Claude Desktop

In `claude_desktop_config.json` (Settings, Developer, Edit config):

```json
{
  "mcpServers": {
    "hunch-book": {
      "command": "node",
      "args": ["/absolute/path/to/hunch-book/packages/mcp/dist/main.js"],
      "env": {
        "HUNCH_MCP_NETWORK": "monad-testnet"
      }
    }
  }
}
```

To let it trade, add `"HUNCH_MCP_PRIVATE_KEY"` to `env` with the agent wallet's key, and adjust the
limits. Restart Claude Desktop after editing.

## Claude Code

```sh
# read-only
claude mcp add hunch-book -e HUNCH_MCP_NETWORK=monad-testnet -- node /absolute/path/to/hunch-book/packages/mcp/dist/main.js

# with a wallet: the key comes from your shell, not the command history
claude mcp add hunch-book -e HUNCH_MCP_NETWORK=monad-testnet -e HUNCH_MCP_PRIVATE_KEY="$AGENT_KEY" \
  -e HUNCH_MCP_MAX_USDC_PER_CALL=25 -- node /absolute/path/to/hunch-book/packages/mcp/dist/main.js
```

Or a project `.mcp.json` (keep keys out of it; Claude Code expands `${VAR}` from your environment):

```json
{
  "mcpServers": {
    "hunch-book": {
      "command": "node",
      "args": ["/absolute/path/to/hunch-book/packages/mcp/dist/main.js"],
      "env": {
        "HUNCH_MCP_NETWORK": "monad-testnet",
        "HUNCH_MCP_PRIVATE_KEY": "${AGENT_KEY}",
        "HUNCH_MCP_MAX_USDC_PER_CALL": "25"
      }
    }
  }
}
```

The same snippets are in [`examples/mcp-config`](../examples/mcp-config).

## Environment

| Variable | Default | What it does |
|---|---|---|
| `HUNCH_MCP_NETWORK` | `monad-testnet` | or `monad-mainnet` |
| `HUNCH_MCP_RPC_URL` | the deployment's RPC | a private RPC is faster and less rate-limited |
| `HUNCH_MCP_PRIVATE_KEY` | none | the agent wallet's key; without it the server is read-only |
| `HUNCH_MCP_MAX_USDC_PER_CALL` | `100` | USDC per stake, buy or first stake |
| `HUNCH_MCP_MAX_TOKENS_PER_CALL` | `200` | tokens per sell |
| `HUNCH_MCP_MAX_SLIPPAGE_BPS` | `300` | the highest slippage a trade may ask for |
| `HUNCH_MCP_DEFAULT_SLIPPAGE_BPS` | `100` | slippage when the agent names none |
| `HUNCH_MCP_ALLOW_MAINNET_WRITES` | off | `1` turns write tools on for mainnet |
| `HUNCH_MCP_PYTH_API_KEY` | none | lets `settle` fetch Pyth updates for Pyth price markets |

## Example

The tools' answers below were read from Monad testnet on 2026-10-04 (block 68,062,566), from the
read-only server:

> **You:** What can I bet on right now?
>
> **Agent** (calls `list_markets` with `phase: "trading"`): Market #1 asks whether MON longs pay more
> than $0.000015 per MON in funding on Perpl between blocks 68,058,301 and 68,264,005. The book prices
> YES at 0.368 bid, 0.399 ask.
>
> **You:** What would 5 NO cost?
>
> **Agent** (calls `quote` with `kind: "buyNo"`, `amount: "5"`): 3.16 USDC, an average of 0.632 per
> NO, with a limit of 3.1916 USDC at 1% slippage.

With a wallet, the agent would then call `trade` with the same arguments and return the transaction's
MonadScan link.

## Tests

```sh
pnpm --filter @hunch-book/mcp test
```

Tests cover the config (defaults, limits, mainnet gating, a bad key never echoed), every tool's schema
and handler against a fake SDK (filters, plain-unit output, every per-call limit checked before a
transaction, settle refusing to send when the answer is not in, errors in plain words, JSON params for
all seven templates), and the server over the MCP protocol itself (an in-memory client lists the tools,
calls them and reads the doc resources).
