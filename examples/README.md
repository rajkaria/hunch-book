# Examples

Small programs on Hunch Book's developer surface. Each one has its own README.

| Example | What it shows |
|---|---|
| [`read-markets`](./read-markets) | list markets, read a book and quote a trade with the SDK, read-only |
| [`agent-trader`](./agent-trader) | an agent that watches Perpl funding markets and buys YES under a budget; dry run by default |
| [`mcp-config`](./mcp-config) | config for running the MCP server in Claude Desktop and Claude Code |

The TypeScript examples are pnpm workspace packages so they install the SDK from this repository; they
have no build step and run with `tsx`. Build the SDK first:

```sh
pnpm install
pnpm --filter "@hunch-book/sdk..." build
```

Guides: [SDK](../docs/SDK.md), [MCP server](../docs/MCP.md), [data API](../docs/API.md).
