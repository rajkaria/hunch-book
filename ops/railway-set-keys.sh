#!/usr/bin/env bash
# Copies the keeper's and the maker's keys from .env into the Railway services that sign with them.
# Each value goes through stdin, so a key never appears in a command line, shell history or log; this
# script prints names only. Run it yourself, from the repository root, once the checkout is linked to
# the Railway project (`railway link`, project hunch-book). See ops/README.md, "Always on".
#
#   bash ops/railway-set-keys.sh            # keeper-mainnet, keeper-testnet, maker-testnet
#   ENV_FILE=/path/to/.env bash ops/railway-set-keys.sh
#
# Setting a variable does not redeploy here (--skip-deploys): the services keep running as a dry run
# until KEEPER_ENABLED or MAKER_ENABLED is set to 1, which redeploys them with the key in place.
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "no $ENV_FILE here: run from the repository root or set ENV_FILE" >&2
  exit 1
fi
command -v railway >/dev/null || { echo "the Railway CLI is not installed (npm i -g @railway/cli)" >&2; exit 1; }

# The last NAME=value line, without surrounding quotes. Never echoed.
value() {
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

copy() {
  local name="$1" service="$2"
  if [ -z "$(value "$name")" ]; then
    echo "skip: $name is not in $ENV_FILE"
    return
  fi
  value "$name" | railway variable set --service "$service" --stdin "$name" --skip-deploys >/dev/null
  echo "set $name on $service"
}

copy KEEPER_PRIVATE_KEY keeper-mainnet
copy KEEPER_PRIVATE_KEY keeper-testnet
copy MAKER_PRIVATE_KEY maker-testnet
echo "Done. Turn each service on with: railway variable set --service <service> KEEPER_ENABLED=1 (or MAKER_ENABLED=1)"
