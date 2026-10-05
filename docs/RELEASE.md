# Releasing the npm packages

Four packages are published to npm, in this order, because each depends on the ones before it:

| Package | Folder | What it is |
|---|---|---|
| `@hunch-book/deployments` | [`deployments`](../deployments) | the contract addresses, the only source of them |
| `@hunch-book/shared` | [`packages/shared`](../packages/shared) | ABIs, chain configs, template codecs, shared types |
| `@hunch-book/sdk` | [`packages/sdk`](../packages/sdk) | the TypeScript SDK ([SDK.md](./SDK.md)) |
| `@hunch-book/mcp` | [`packages/mcp`](../packages/mcp) | the MCP server, with the `hunch-book-mcp` command ([MCP.md](./MCP.md)) |

Status: **ready, not published yet**. Publishing needs an npm token for the `@hunch-book` scope.

## What is checked on every push

`node scripts/check-packages.mjs` packs each package exactly as `pnpm publish` would (pnpm applies
`publishConfig`, so types point at `dist/*.d.ts`, and turns `workspace:` ranges into versions), opens
each tarball and checks it:

- not private, MIT, a repository link, `access: public`;
- every file `package.json` names (main, types, exports, the bin) is in the tarball, and no field points
  at TypeScript source;
- the bin starts with `#!/usr/bin/env node`;
- a README and the license ship; source, tests, configs and `.env` files do not;
- every package a built file imports is a declared dependency.

CI also runs it with `--install`: the four tarballs are installed into an empty project from the npm
registry, each package is imported, and the MCP server is checked to carry the documents it serves (they
are copied in by its `prepack` script). `bash scripts/verify-all.sh` runs the same checks without the
install.

## Publishing

1. On npmjs.com, create the `hunch-book` organisation (for the `@hunch-book` scope) and an automation
   token that can publish to it.
2. In the GitHub repository: Settings, Secrets and variables, Actions, New repository secret:
   `NPM_TOKEN` with that token.
3. Actions, **release**, Run workflow, with **dry_run** ticked. It builds, tests, packs, installs and
   stops. Check it is green.
4. Run it again with **dry_run** unticked. It publishes the four packages with npm provenance (each
   version links back to the workflow run and commit). A version already on npm is skipped.

For a later release, bump `version` in each changed package's `package.json`, add a section to its
`CHANGELOG.md`, and bump the packages that depend on it, then run the workflow again.
