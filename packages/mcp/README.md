# @hunch-book/mcp

An MCP server that lets agents use Hunch Book: list markets, read their exact rules, quote, trade,
stake, create markets, settle them with evidence found automatically, collect winnings and verify any
settlement, with their own wallet. Stdio transport, Monad testnet by default, read-only without a key.

Status: **building**. The full guide, with Claude Desktop and Claude Code config, is
[docs/MCP.md](../../docs/MCP.md).

```sh
pnpm --filter "@hunch-book/mcp..." build
node packages/mcp/dist/main.js            # read-only on Monad testnet
HUNCH_MCP_PRIVATE_KEY=... node packages/mcp/dist/main.js   # with a wallet (use one made for the agent)
```

| Tool | Kind |
|---|---|
| `status`, `list_markets`, `get_market`, `quote`, `get_portfolio`, `verify_settlement` | read |
| `create_market`, `stake`, `trade`, `settle`, `redeem`, `get_test_usdc` | write, only with `HUNCH_MCP_PRIVATE_KEY` |

Per-call limits (`HUNCH_MCP_MAX_USDC_PER_CALL`, `HUNCH_MCP_MAX_TOKENS_PER_CALL`,
`HUNCH_MCP_MAX_SLIPPAGE_BPS`) are checked before anything is signed, every write is simulated first, and
every write returns its explorer link. Mainnet writes need `HUNCH_MCP_ALLOW_MAINNET_WRITES=1`.

```sh
pnpm --filter @hunch-book/mcp test
```
