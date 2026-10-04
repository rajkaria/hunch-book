import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Block, parseIncidents } from "./incidents";

// Server only: the status page reads docs/INCIDENTS.md when the site is built (the page is static).
// The reads run only during the build, so they are kept out of the server bundle's file tracing.

/** docs/INCIDENTS.md from the repository, whether the build runs in apps/web or at the root. */
export function readIncidentLog(cwd: string = process.cwd()): Block[] {
  for (const path of [join(cwd, "../../docs/INCIDENTS.md"), join(cwd, "docs/INCIDENTS.md")]) {
    if (existsSync(/*turbopackIgnore: true*/ path)) {
      return parseIncidents(readFileSync(/*turbopackIgnore: true*/ path, "utf8"));
    }
  }
  return parseIncidents(
    "The incident log could not be read when this page was built. It lives in docs/INCIDENTS.md.",
  );
}
