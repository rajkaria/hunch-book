#!/usr/bin/env node
// Checks the four npm packages exactly as they would be published: packs each one with pnpm (which
// applies publishConfig and turns workspace: ranges into versions), opens the tarball and checks it.
//
//   node scripts/check-packages.mjs            the tarball checks (fast, offline)
//   node scripts/check-packages.mjs --install  also installs the four tarballs into an empty project
//                                              from the npm registry and imports each one (CI, release)
//
// Build first: pnpm --filter "@hunch-book/mcp..." build
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** In publish order: each depends only on the ones before it. */
export const PACKAGES = [
  { dir: "deployments", name: "@hunch-book/deployments", imports: [] },
  { dir: "packages/shared", name: "@hunch-book/shared", imports: ["deployments", "Phase", "marketAbi"] },
  {
    dir: "packages/sdk",
    name: "@hunch-book/sdk",
    imports: ["createHunchClient", "collectAll", "verifySettlement"],
  },
  { dir: "packages/mcp", name: "@hunch-book/mcp", imports: ["createServer", "TOOLS"], bin: "hunch-book-mcp" },
];

/** Most a tarball may hold unpacked, so a stray build artefact cannot ship. */
const MAX_UNPACKED_BYTES = 6 * 1024 * 1024;
const FORBIDDEN = [/^src\//, /^test\//, /(^|\/)\.env/, /\.test\.[jt]s$/, /tsconfig/, /(^|\/)node_modules\//];

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

/** Package names a built file imports: bare specifiers only, subpaths cut to the package. */
export function importedPackages(source) {
  const names = new Set();
  // Statement-level only (a line that starts an import or export, or closes a multi-line one), so text
  // inside strings, such as an ABI or a sentence with "from" in it, is never read as an import.
  const specifiers = [
    ...source.matchAll(/^(?:\s*(?:import|export)\b[^\n]*?|\s*\})\s*from\s*["']([^"'./][^"']*)["']/gm),
    ...source.matchAll(/^\s*import\s*["']([^"'./][^"']*)["']/gm),
    ...source.matchAll(/\bimport\(\s*["']([^"'./][^"']*)["']\s*\)/g),
  ].map((m) => m[1]);
  for (const spec of specifiers) {
    if (spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0])) continue;
    const parts = spec.split("/");
    names.add(spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  return names;
}

/** Every problem with one unpacked package, as plain sentences. */
export function checkPackage(pkgDir, spec) {
  const problems = [];
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const all = files(pkgDir).map((f) => relative(pkgDir, f));
  const has = (p) => all.includes(p.replace(/^\.\//, ""));

  if (manifest.name !== spec.name) problems.push(`name is ${manifest.name}, expected ${spec.name}`);
  if (manifest.private) problems.push("package.json is private: true");
  if (manifest.license !== "MIT") problems.push("license is not MIT");
  if (!manifest.repository?.url) problems.push("no repository url");
  if (manifest.publishConfig?.access !== "public") problems.push("publishConfig.access is not public");
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith("workspace:")) problems.push(`${field}.${dep} is still ${range}`);
    }
  }
  for (const file of ["README.md", "LICENSE"]) if (!has(file)) problems.push(`${file} is missing`);

  const targets = [manifest.main, manifest.types];
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === "string") targets.push(value);
    else targets.push(value?.types, value?.default, value?.import);
  }
  for (const t of targets.filter(Boolean)) {
    if (!has(t)) problems.push(`${t} is named in package.json but is not in the tarball`);
    if (/\.ts$/.test(t) && !/\.d\.ts$/.test(t)) problems.push(`${t} points at TypeScript source`);
  }
  if (spec.bin) {
    const bin = manifest.bin?.[spec.bin];
    if (!bin) problems.push(`bin ${spec.bin} is missing`);
    else if (!has(bin)) problems.push(`bin ${spec.bin} points at ${bin}, which is not in the tarball`);
    else if (!readFileSync(join(pkgDir, bin), "utf8").startsWith("#!/usr/bin/env node")) {
      problems.push(`bin ${spec.bin} has no #!/usr/bin/env node line`);
    }
  }

  for (const f of all) if (FORBIDDEN.some((re) => re.test(f))) problems.push(`${f} should not ship`);
  const size = all.reduce((sum, f) => sum + statSync(join(pkgDir, f)).size, 0);
  if (size > MAX_UNPACKED_BYTES) problems.push(`unpacked size ${size} bytes is over ${MAX_UNPACKED_BYTES}`);

  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const f of all.filter((p) => p.endsWith(".js"))) {
    for (const name of importedPackages(readFileSync(join(pkgDir, f), "utf8"))) {
      if (name !== manifest.name && !declared.has(name)) {
        problems.push(`${f} imports ${name}, which is not in dependencies`);
      }
    }
  }
  return { problems, size, files: all.length };
}

function pack(spec, dest) {
  const out = execFileSync("pnpm", ["pack", "--pack-destination", dest], {
    cwd: join(ROOT, spec.dir),
    encoding: "utf8",
  });
  const tarball = out
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.endsWith(".tgz"));
  if (!tarball) throw new Error(`pnpm pack printed no tarball for ${spec.name}`);
  return tarball;
}

function install(tarballs, work) {
  const project = join(work, "consumer");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], {
    cwd: project,
    stdio: "inherit",
  });
  const lines = [];
  for (const spec of PACKAGES) {
    if (spec.imports.length === 0) continue;
    lines.push(
      `{ const m = await import(${JSON.stringify(spec.name)}); for (const n of ${JSON.stringify(spec.imports)}) if (!(n in m)) throw new Error(${JSON.stringify(spec.name)} + " exports no " + n); console.log("ok   import ${spec.name}"); }`,
    );
  }
  lines.push(
    `{ const t = await import("@hunch-book/deployments/monad-testnet.json", { with: { type: "json" } }); if (!t.default.hunchBook?.factory) throw new Error("no factory address"); console.log("ok   import @hunch-book/deployments/monad-testnet.json"); }`,
  );
  writeFileSync(join(project, "smoke.mjs"), `${lines.join("\n")}\n`);
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: project, stdio: "inherit" });
  const docs = join(project, "node_modules/@hunch-book/mcp/docs/PROTOCOL.md");
  if (!existsSync(docs)) throw new Error("the installed MCP server has no docs/PROTOCOL.md to serve");
  console.log("ok   the installed MCP server carries its documents");
}

function main() {
  const work = mkdtempSync(join(tmpdir(), "hunch-book-pack-"));
  try {
    run(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function run(work) {
  let failed = 0;
  const tarballs = [];
  for (const spec of PACKAGES) {
    const tarball = pack(spec, work);
    tarballs.push(tarball);
    const into = join(work, spec.dir.replaceAll("/", "-"));
    mkdirSync(into);
    execFileSync("tar", ["-xzf", tarball, "-C", into]);
    const { problems, size, files: count } = checkPackage(join(into, "package"), spec);
    if (problems.length === 0) {
      console.log(`ok   ${spec.name}: ${count} files, ${(size / 1024).toFixed(0)} KB unpacked`);
    } else {
      failed += problems.length;
      console.log(`FAIL ${spec.name}`);
      for (const p of problems) console.log(`     ${p}`);
    }
  }
  if (failed === 0 && process.argv.includes("--install")) install(tarballs, work);
  if (failed > 0) {
    console.log(`${failed} problems`);
    process.exitCode = 1;
    return;
  }
  console.log("packages ready to publish");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
