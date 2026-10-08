#!/usr/bin/env bash
# Tests for scripts/run-local-services.sh's settings handling (the `config` command): which file wins,
# quoting, and that keys are refused outside .env. Runs the script from a copy in a temporary root, so
# nothing here touches .run/ or starts a service.
#
#   bash scripts/test/run-local-services.test.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/run-local-services.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/.run"
cp "$SRC" "$TMP/scripts/run-local-services.sh"

failures=0
check() {
  local name="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "ok   $name"
  else
    echo "FAIL $name: expected to find: $needle"
    echo "---- output:"
    echo "$haystack"
    echo "----"
    failures=$((failures + 1))
  fi
}
check_absent() {
  local name="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "FAIL $name: did not expect: $needle"
    failures=$((failures + 1))
  else
    echo "ok   $name"
  fi
}

# The shell under test: the default bash, or another one (macOS launchd runs /bin/bash, which is 3.2).
BASH_UNDER_TEST="${BASH_UNDER_TEST:-bash}"

run() {
  # A clean environment, so the caller's KEEPER_* or MAKER_* variables cannot leak in.
  env -i PATH="$PATH" HOME="$HOME" "$@" "$BASH_UNDER_TEST" "$TMP/scripts/run-local-services.sh" config all 2>&1
}

cat >"$TMP/.env" <<'ENV'
KEEPER_PRIVATE_KEY=0xabc
MAKER_ENABLED=0
MONAD_TESTNET_RPC=https://example.invalid
ENV

out="$(run)"
check "no settings file: keeper is a dry run" "$out" "keeper: dry run (KEEPER_ENABLED=)"
check "no settings file: .env value is reported" "$out" "maker: dry run (MAKER_ENABLED=0)"
check "missing settings file is named" "$out" "services.env (missing)"

cat >"$TMP/.run/services.env" <<'SETTINGS'
# comment
KEEPER_ENABLED=1
export KEEPER_POLL_SECONDS="30"
KEEPER_SERIES_FILE='/data/series.json'
MAKER_ENABLED=1
KEEPER_PRIVATE_KEY=0xdef
MAKER_TELEGRAM_TOKEN=nope
NOTIFIER_ENABLED=1
MONAD_TESTNET_RPC=https://settings.invalid

SETTINGS

out="$(run)"
check "settings file turns the keeper live" "$out" "keeper: live (KEEPER_ENABLED=1)"
check "settings file wins over .env" "$out" "maker: live (MAKER_ENABLED=1)"
check "export prefix and double quotes are handled" "$out" "KEEPER_POLL_SECONDS=30"
check "single quotes are handled" "$out" "KEEPER_SERIES_FILE=/data/series.json"
check "MONAD_ variables are passed to each service" "$out" "MONAD_TESTNET_RPC=https://settings.invalid"
check "keys are refused" "$out" "refusing KEEPER_PRIVATE_KEY"
check "tokens are refused" "$out" "refusing MAKER_TELEGRAM_TOKEN"
check_absent "a key is never passed on" "$out" "KEEPER_PRIVATE_KEY=0xdef"
check_absent "another service's variables are skipped" "$out" "NOTIFIER_ENABLED"

out="$(run KEEPER_ENABLED=0 KEEPER_POLL_SECONDS=5)"
check "the shell wins over the settings file" "$out" "keeper: dry run (KEEPER_ENABLED=0)"
check_absent "a variable the shell sets is not passed again" "$out" "KEEPER_POLL_SECONDS=30"

out="$(run SERVICES_ENV_FILE="$TMP/none.env")"
check "SERVICES_ENV_FILE picks another file" "$out" "none.env (missing)"

# exec: the service replaces the shell, in its own directory, with the settings and the .env path.
mkdir -p "$TMP/services/keeper"
cat >"$TMP/fake-node" <<'NODE'
#!/usr/bin/env bash
echo "cwd=$PWD"
echo "args=$*"
echo "enabled=${KEEPER_ENABLED:-}"
echo "envfile=${KEEPER_ENV_FILE:-}"
echo "maker=${MAKER_ENABLED:-unset}"
NODE
chmod +x "$TMP/fake-node"
# A stand-in caffeinate records how it was called.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/caffeinate" <<CAF
#!/usr/bin/env bash
echo "\$*" >"$TMP/caffeinate.args"
CAF
chmod +x "$TMP/bin/caffeinate"
out="$(env -i PATH="$TMP/bin:$PATH" HOME="$HOME" NODE_BIN="$TMP/fake-node" "$BASH_UNDER_TEST" \
  "$TMP/scripts/run-local-services.sh" exec keeper 2>&1)"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$TMP/caffeinate.args" ] && break; sleep 0.2; done
check "exec keeps the Mac awake for the service's pid" "$(cat "$TMP/caffeinate.args" 2>/dev/null)" "-is -w "
check "exec says it keeps the Mac awake" "$out" "keeping this Mac awake"
rm -f "$TMP/caffeinate.args"
out_quiet="$(env -i PATH="$TMP/bin:$PATH" HOME="$HOME" NODE_BIN="$TMP/fake-node" KEEP_AWAKE=0 "$BASH_UNDER_TEST" \
  "$TMP/scripts/run-local-services.sh" exec keeper 2>&1)"
sleep 0.5
check_absent "exec with KEEP_AWAKE=0 leaves sleep alone" "$out_quiet" "keeping this Mac awake"
check "exec with KEEP_AWAKE=0 runs no caffeinate" "$([ -e "$TMP/caffeinate.args" ] && echo ran || echo none)" "none"
check "exec reports the mode" "$out" "(live)"
check "exec runs the service's entry point" "$out" "args=--import tsx src/main.ts run"
check "exec runs in the service's directory" "$out" "cwd=$TMP/services/keeper"
check "exec passes the settings" "$out" "enabled=1"
check "exec passes the .env path" "$out" "envfile=$TMP/.env"
check "exec passes no other service's settings" "$out" "maker=unset"

# start and stop: the pid file names the service itself (not a wrapper), in a session of its own, and
# stop ends it. The fake service only sleeps; its command line looks like a real one.
cat >"$TMP/fake-service" <<'NODE'
#!/usr/bin/env bash
trap 'exit 0' TERM
while :; do sleep 1; done
NODE
chmod +x "$TMP/fake-service"
svc_env=(env -i PATH="$PATH" HOME="$HOME" NODE_BIN="$TMP/fake-service" SKIP_SHARED_BUILD=1 KEEP_AWAKE=0 STOP_WAIT=10)
out="$("${svc_env[@]}" "$BASH_UNDER_TEST" "$TMP/scripts/run-local-services.sh" start keeper 2>&1)"
check "start reports the mode" "$out" "keeper: started, live"
pid="$(cat "$TMP/.run/keeper.pid" 2>/dev/null || true)"
cmd="$(ps -p "${pid:-0}" -o command= 2>/dev/null || true)"
check "the pid file names the service process" "$cmd" "src/main.ts run"
pgid="$(ps -p "${pid:-0}" -o pgid= 2>/dev/null | tr -d ' ' || true)"
check "the service leads its own process group" "pgid=$pgid" "pgid=$pid"
out="$("${svc_env[@]}" "$BASH_UNDER_TEST" "$TMP/scripts/run-local-services.sh" status keeper 2>&1)"
check "status sees it running" "$out" "keeper: running (pid $pid"
out="$("${svc_env[@]}" "$BASH_UNDER_TEST" "$TMP/scripts/run-local-services.sh" stop keeper 2>&1)"
check "stop stops it" "$out" "stopped"
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  echo "FAIL the service is still running after stop"
  kill -KILL "$pid" 2>/dev/null || true
  failures=$((failures + 1))
else
  echo "ok   the service is gone after stop"
fi
out="$("${svc_env[@]}" KEEPER_ENABLED=0 "$BASH_UNDER_TEST" "$TMP/scripts/run-local-services.sh" start keeper 2>&1)"
check "a dry-run start warns" "$out" "WARNING: starting as a DRY RUN"
"${svc_env[@]}" "$BASH_UNDER_TEST" "$TMP/scripts/run-local-services.sh" stop keeper >/dev/null 2>&1 || true

if [ "$failures" -gt 0 ]; then
  echo "$failures failed"
  exit 1
fi
echo "all passed"
