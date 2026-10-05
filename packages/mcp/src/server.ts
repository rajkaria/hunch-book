import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHunchClient, describeError, monadMainnet, monadTestnet, toJsonSafe } from "@hunch-book/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type McpConfig, writesEnabled } from "./config.js";
import { type HunchPort, TOOLS, type ToolContext, type ToolDef, ToolInputError } from "./tools.js";

// The MCP server: Hunch Book's tools and its protocol documents as resources. `createServer` takes
// the SDK through the same narrow port the tools use, so tests build it with a fake.

export { parseConfig, writesEnabled } from "./config.js";
export { parseTemplateParams, TOOLS } from "./tools.js";
export type { HunchPort, McpConfig };

export const SERVER_NAME = "hunch-book";
export const SERVER_VERSION = "0.1.0";

/** Documents served as resources, from the repository's docs/ folder. */
export const DOCS = [
  {
    name: "protocol",
    file: "PROTOCOL.md",
    title: "Hunch Book protocol",
    description: "How markets, pools, graduation, the book and settlement work.",
  },
  {
    name: "templates",
    file: "TEMPLATES.md",
    title: "Hunch Book templates",
    description: "Every template: the question, params, source, exact rule, evidence and trust.",
  },
  {
    name: "periphery",
    file: "PERIPHERY.md",
    title: "Hunch Book periphery",
    description: "Auto-redeem, conditional orders, referrals, rewards and the oracle.",
  },
  {
    name: "sdk",
    file: "SDK.md",
    title: "Hunch Book TypeScript SDK",
    description: "The SDK this server is built on.",
  },
] as const;

/**
 * Where the documents are: the package's own docs/ in an installed copy (copied there when it is packed),
 * then the repository's docs/ in a checkout.
 */
const DOC_DIRS = [
  fileURLToPath(new URL("../docs/", import.meta.url)),
  fileURLToPath(new URL("../../../docs/", import.meta.url)),
];

export function readDoc(file: string, dirs: readonly string[] = DOC_DIRS): string {
  for (const dir of dirs) {
    const path = `${dir}${file}`;
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return `${file} is not available in this installation.`;
}

export const INSTRUCTIONS = [
  "Hunch Book runs yes/no prediction markets on Monad in USDC. A market starts as a pool (stake on YES or NO),",
  "graduates to a Kuru order book once it proves demand (trade YES and NO any time), and settles by reading",
  "onchain data: no person sets an outcome. Amounts are decimal strings in USDC or tokens. Start with",
  "list_markets, read a market with get_market, quote before you trade, and check any settlement with",
  "verify_settlement. Every transaction result has an explorer link.",
].join(" ");

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Runs one tool and shapes the answer for MCP: JSON text, or a plain-word error. */
export async function runTool(def: ToolDef, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const result = toJsonSafe(await def.handler(input as never, ctx)) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (e) {
    const message = e instanceof ToolInputError ? e.message : describeError(e);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** The tools this configuration offers: every read tool, and the write tools only with a wallet. */
export function offeredTools(config: McpConfig): ToolDef[] {
  const writes = writesEnabled(config);
  return (TOOLS as readonly ToolDef[]).filter((t) => !t.write || writes);
}

export function createServer(sdk: HunchPort, config: McpConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolContext = { sdk, config };
  for (const def of offeredTools(config)) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { readOnlyHint: !def.write, destructiveHint: false, openWorldHint: true },
      },
      (async (input: unknown) => runTool(def, input, ctx)) as never,
    );
  }
  for (const doc of DOCS) {
    const uri = `docs://hunch-book/${doc.name}`;
    server.registerResource(
      doc.name,
      uri,
      { title: doc.title, description: doc.description, mimeType: "text/markdown" },
      async () => ({
        contents: [{ uri, mimeType: "text/markdown", text: readDoc(doc.file) }],
      }),
    );
  }
  return server;
}

/** The real SDK for a configuration: read-only without a key, with a wallet client otherwise. */
export function createSdk(config: McpConfig): HunchPort {
  const chain = config.network === "monad-mainnet" ? monadMainnet : monadTestnet;
  const walletClient =
    config.privateKey && writesEnabled(config)
      ? createWalletClient({
          account: privateKeyToAccount(config.privateKey),
          chain,
          transport: http(config.rpcUrl, { timeout: 30_000, retryCount: 2 }),
        })
      : undefined;
  return createHunchClient({
    network: config.network,
    rpcUrl: config.rpcUrl,
    walletClient,
    pyth: config.pythApiKey ? { apiKey: config.pythApiKey } : undefined,
  });
}
