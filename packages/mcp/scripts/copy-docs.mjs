// Runs before `pnpm pack` and `pnpm publish` (prepack): copies the documents the server serves as MCP
// resources from the repository's docs/ into this package's docs/ (gitignored), so an installed copy
// serves them too. The list is DOCS in src/server.ts.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "../../../docs");
const to = join(here, "../docs");
const FILES = ["PROTOCOL.md", "TEMPLATES.md", "PERIPHERY.md", "SDK.md"];

mkdirSync(to, { recursive: true });
for (const file of FILES) copyFileSync(join(from, file), join(to, file));
console.log(`copied ${FILES.length} documents into ${to}`);
