# Hunch Book: rules for anyone (human or AI agent) working in this repo

Prediction markets on Monad that start as USDC pools, graduate to Kuru's onchain order book,
and settle by reading the chain. Design: [docs/PROTOCOL.md](./docs/PROTOCOL.md).
Plan: [docs/ROADMAP.md](./docs/ROADMAP.md).

## Rule 1: this repo is public, and only public material goes in it

This repository is public from its first commit. Every file and every commit message can be read
by anyone, forever.

- Internal material lives in `internal/` at the root of this checkout. That folder is gitignored and
  is never committed or pushed. It holds plans, task lists, ownership maps, handoffs, strategy,
  outreach drafts, notes about other teams, event notes, form answers, video scripts and pitch drafts.
- Write internal material **there, from the start**. Never draft it in a tracked file and move it later.
- Never copy, quote or summarise an internal file into a tracked file.
- Git worktrees do not contain `internal/` (ignored files are not checked out). Agents working in a
  worktree read it by absolute path: `~/Projects/hunch-book/internal/`.
- Never run `git clean -x`, `git clean -X` or `git clean -fdx` in the main checkout: they delete
  ignored files, including `internal/`. Never `git add -f` anything under `internal/`.
- Never create top-level `notes/`, `private/`, `scratch/`, `hackathon/`, `submission/` or `video/`
  folders; internal material goes under `internal/`.
- If you are unsure whether something is public, it is internal.
- Enforcement: the pre-commit hook (`.git/hooks/pre-commit`, installed by the setup script) and CI
  (`.github/workflows/boundary.yml` → `scripts/check-public-boundary.sh`) block `internal/` and other
  internal paths, the internal marker line, `.env` files and token-shaped strings. Do not bypass them.
  Deploy configs must exclude it too (for example `internal/` in `.vercelignore`).

## Rule 2: secrets

Keys and tokens live only in `.env` (gitignored) or the host's environment settings. Never in a
commit, an issue, a log line or a chat message. Code reads variable names (`DEPLOYER_PRIVATE_KEY`,
`MAKER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`).

## Rule 3: money paths

- No address, including ours, can set a market's outcome by hand. Outcomes come only from a
  resolver reading onchain data.
- The guardian can pause market creation and graduation. It can never pause settlement or
  redemption, never move user funds and never set outcomes.
- Every change to `contracts/src/` ships with Foundry tests: unit, fuzz, and the invariant suite
  (solvency, equal YES/NO supply, pool claims never exceed the pool).
- `deployments/<network>.json` is the only source of contract addresses. Every reader (app,
  indexer, bots, docs) loads from it.

## Rule 4: claims

- Never describe unbuilt work as done. Status words: planned, building, live.
- Every number in the README or on the site comes from chain data (indexer, explorer) or from
  `docs/FACTS.md`. Every "live" claim has a transaction or address link.
- Activity by our own maker bot or keeper is labelled as ours wherever it is counted.

## Rule 5: how work lands

- Lanes own directories (see the workstreams table in docs/ROADMAP.md). Do not edit another lane's
  directory; change a shared interface only by agreement, in its own commit.
- Commit each completed task when it lands, with a real message, and push it once the gate below
  passes, so the public repo always shows the current state of the work. Only public material is
  pushed: plans, notes and session summaries stay in `internal/`. No same-minute bursts, no history
  rewrites, no force pushes to `main`.
- Gate before every push: `forge build && forge test` for contracts; `pnpm typecheck && pnpm lint &&
  pnpm test && pnpm build` for TypeScript packages once they exist; `bash scripts/check-public-boundary.sh`.
- Copy: plain words, short sentences, no em dashes, numbers in full.

## Layout (as lanes land)

```
contracts/          Foundry: src/core, src/resolvers, src/interfaces, test/, script/
packages/shared/    ABIs, addresses loader, shared types
services/maker/     open-source quoting bot (Kuru)
services/keeper/    graduation, settlement, touch proofs, recurring series, auto-redeem
indexer/            Envio HyperIndex
apps/web/           Next.js app
deployments/        monad-testnet.json, monad-mainnet.json
docs/               PROTOCOL.md, ROADMAP.md, FACTS.md
```
