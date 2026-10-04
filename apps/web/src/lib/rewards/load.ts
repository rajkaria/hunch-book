import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EpochFile } from "./epochs";
import { parseEpochFiles } from "./epochs";

// Server only: the epoch files published with the app, in apps/web/public/rewards/*.json. Read when the
// page renders (at build time for the static page), so the browser gets them without a directory listing.

export const REWARDS_DIR = join("public", "rewards");

/** A plain-JSON copy of an epoch file, safe to pass from a server component (bigints as strings). */
export interface SerializedEpoch {
  epoch: string;
  token: string;
  total: string;
  root: string;
  claimDeadline: number | null;
  kind: EpochFile["kind"];
  source: string;
  claims: { account: string; amount: string; proof: string[] }[];
}

export function serializeEpoch(f: EpochFile): SerializedEpoch {
  return {
    epoch: f.epoch.toString(),
    token: f.token,
    total: f.total.toString(),
    root: f.root,
    claimDeadline: f.claimDeadline,
    kind: f.kind,
    source: f.source,
    claims: f.claims.map((c) => ({ account: c.account, amount: c.amount.toString(), proof: c.proof })),
  };
}

/** Every epoch file in public/rewards, newest epoch first, and a sentence for each file that failed. */
export async function loadPublishedEpochs(
  dir: string = join(process.cwd(), REWARDS_DIR),
): Promise<{ epochs: SerializedEpoch[]; errors: string[] }> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".json")).sort();
  } catch {
    return { epochs: [], errors: [] };
  }
  const epochs: SerializedEpoch[] = [];
  const errors: string[] = [];
  for (const name of names) {
    try {
      const json: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      const parsed = parseEpochFiles(json, `rewards/${name}`);
      epochs.push(...parsed.files.map(serializeEpoch));
      errors.push(...parsed.errors);
    } catch {
      errors.push(`rewards/${name}: not valid JSON.`);
    }
  }
  epochs.sort((a, b) => (BigInt(b.epoch) > BigInt(a.epoch) ? 1 : BigInt(b.epoch) < BigInt(a.epoch) ? -1 : 0));
  return { epochs, errors };
}
