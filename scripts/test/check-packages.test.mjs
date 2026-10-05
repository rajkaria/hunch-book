// Tests for scripts/check-packages.mjs's checks, on hand-made package folders.
//   node --test scripts/test/check-packages.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPackage, importedPackages } from "../check-packages.mjs";

const SPEC = { name: "@x/pkg", imports: [], bin: "x-bin" };

function makePackage(manifest, extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-packages-"));
  const files = {
    "package.json": JSON.stringify(manifest),
    "README.md": "# x",
    LICENSE: "MIT",
    "dist/index.js": 'import { a } from "viem";\nexport const b = 1;\n',
    "dist/index.d.ts": "export declare const b: number;\n",
    "dist/main.js": "#!/usr/bin/env node\nimport './index.js';\n",
    ...extraFiles,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const good = {
  name: "@x/pkg",
  version: "0.1.0",
  license: "MIT",
  repository: { url: "git+https://example.invalid/x.git" },
  publishConfig: { access: "public" },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  bin: { "x-bin": "./dist/main.js" },
  dependencies: { viem: "2.57.2" },
};

test("a complete package has no problems", () => {
  assert.deepEqual(checkPackage(makePackage(good), SPEC).problems, []);
});

test("finds what would break an install", () => {
  const { problems } = checkPackage(
    makePackage(
      {
        ...good,
        private: true,
        types: "./src/index.ts",
        dependencies: { "@x/other": "workspace:*" },
        bin: { "x-bin": "./dist/missing.js" },
      },
      { "src/index.ts": "export {}", "dist/extra.js": 'export { z } from "zod";\n' },
    ),
    SPEC,
  );
  const text = problems.join("\n");
  assert.match(text, /private: true/);
  assert.match(
    text,
    /src\/index.ts is named in package.json but is not in the tarball|src\/index.ts points at TypeScript source/,
  );
  assert.match(text, /workspace:\*/);
  assert.match(text, /bin x-bin points at .\/dist\/missing.js/);
  assert.match(text, /src\/index.ts should not ship/);
  assert.match(text, /imports viem, which is not in dependencies/);
  assert.match(text, /imports zod, which is not in dependencies/);
});

test("reads only real import statements", () => {
  const source = [
    'import { a } from "viem";',
    'import x from "@scope/name/sub/path.js";',
    "import {",
    "  b,",
    '} from "zod";',
    'export * from "./local.js";',
    'import "side-effect";',
    'import { readFileSync } from "node:fs";',
    'import { join } from "path";',
    'const abi = [{ name: "from", type: "address" }]; const s = "values from \\"Perpl\\" here";',
    'const later = await import("lazy-pkg");',
  ].join("\n");
  assert.deepEqual([...importedPackages(source)].sort(), [
    "@scope/name",
    "lazy-pkg",
    "side-effect",
    "viem",
    "zod",
  ]);
});
