# MCP config snippets

Ready-to-edit config for the Hunch Book MCP server ([docs/MCP.md](../../docs/MCP.md)). Build the server
once from a checkout of this repository, then replace `/absolute/path/to/hunch-book` with yours:

```sh
pnpm install
pnpm --filter "@hunch-book/mcp..." build
```

| File | For |
|---|---|
| [`claude-desktop.json`](./claude-desktop.json) | Claude Desktop, read-only on Monad testnet: list markets, quote, verify settlements |
| [`claude-desktop-with-wallet.json`](./claude-desktop-with-wallet.json) | Claude Desktop with a wallet, so the agent can stake, trade, settle and collect, within the limits shown |
| [`claude-code.mcp.json`](./claude-code.mcp.json) | a project `.mcp.json` for Claude Code; the key comes from `AGENT_KEY` in your environment, never from the file |

Claude Code can also add the server from the command line:

```sh
claude mcp add hunch-book -e HUNCH_MCP_NETWORK=monad-testnet -- node /absolute/path/to/hunch-book/packages/mcp/dist/main.js
```

Use a wallet made for the agent, funded only with what you are ready to lose, and keep its key out of
any file you commit. On testnet the agent can fund itself with the `get_test_usdc` tool (it also needs a
little testnet MON for gas).
