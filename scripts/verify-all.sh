#!/usr/bin/env bash
# The full local gate, the same checks CI runs (minus the fork suites, which need live RPCs).
# Run it before every push: bash scripts/verify-all.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

step() { printf '\n== %s\n' "$1"; }

step "contracts: format, build, unit + fuzz + invariant tests"
(cd contracts && forge fmt --check && forge build && forge test)

step "ABIs in packages/shared match the contracts"
node scripts/gen-abis.mjs --check

step "typescript: typecheck, lint, test, build"
pnpm --filter @hunch-book/shared build
pnpm typecheck
pnpm lint
pnpm test
pnpm build

step "public boundary"
bash scripts/check-public-boundary.sh

printf '\nall checks passed\n'
