import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Block, parseIncidents } from "./incidents";

// Server only: the status page reads docs/INCIDENTS.md when the site is built.

/** docs/INCIDENTS.md from the repository, whether the build runs in apps/web or at the root. */
export function readIncidentLog(cwd: string = process.cwd()): Block[] {
  for (const path of [join(cwd, "../../docs/INCIDENTS.md"), join(cwd, "docs/INCIDENTS.md")]) {
    if (existsSync(path)) return parseIncidents(readFileSync(path, "utf8"));
  }
  return parseIncidents(
    "The incident log could not be read when this page was built. It lives in docs/INCIDENTS.md.",
  );
}
