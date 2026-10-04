#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseConfig, writesEnabled } from "./config.js";
import { createSdk, createServer, offeredTools } from "./server.js";

// Entry point: an MCP server on stdio. Logs go to stderr (stdout carries the protocol) and never
// include the key.

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const sdk = createSdk(config);
  const server = createServer(sdk, config);
  await server.connect(new StdioServerTransport());
  const mode = writesEnabled(config)
    ? `read and write, wallet ${sdk.account}`
    : config.privateKey
      ? "read-only (mainnet writes need HUNCH_MCP_ALLOW_MAINNET_WRITES=1)"
      : "read-only (no HUNCH_MCP_PRIVATE_KEY)";
  console.error(`hunch-book MCP server on ${config.network}, ${mode}, ${offeredTools(config).length} tools`);
}

main().catch((e: unknown) => {
  console.error(`hunch-book MCP server failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
