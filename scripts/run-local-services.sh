#!/usr/bin/env bash
# Runs Hunch Book's keeper and maker bot in the background on this machine.
#
#   bash scripts/run-local-services.sh start   [keeper|maker|all]
#   bash scripts/run-local-services.sh stop    [keeper|maker|all]
#   bash scripts/run-local-services.sh restart [keeper|maker|all]
#   bash scripts/run-local-services.sh status  [keeper|maker|all]
#   bash scripts/run-local-services.sh config  [keeper|maker|all]   (the settings a start would use)
#   bash scripts/run-local-services.sh logs    [keeper|maker]      (follows the log; Ctrl-C leaves)
#   bash scripts/run-local-services.sh exec    [keeper|maker]      (foreground, for launchd and hosts)
#
# Pid and log files go in .run/ at the repository root (gitignored). Each service loads the repository's
# .env itself (or the file in ENV_FILE) and takes only its own variables (KEEPER_* or MAKER_*, plus
# MONAD_*), so neither process holds the other's key.
#
# Settings that are not secrets (KEEPER_ENABLED, MAKER_HEARTBEAT_SECONDS, ...) go in .run/services.env
# (or the file in SERVICES_ENV_FILE), one NAME=value per line; ops/services.env.example is the testnet
# setup. A variable set in your shell wins over that file, and that file wins over .env. Keys are
# refused there: they stay in .env. Both services run as a dry run unless KEEPER_ENABLED=1 or
# MAKER_ENABLED=1 is set somewhere, and start says so loudly.
#
# Each service starts in a session of its own, so closing the terminal (or ending the tool session) that
# ran start does not signal it. On macOS, start also keeps the Mac from sleeping while a service runs (caffeinate -is, tied to the
# service's pid). KEEP_AWAKE=0 turns that off. A closed laptop lid still sleeps.
#
# stop sends SIGTERM and waits (STOP_WAIT seconds, default 90): the maker cancels every order and
# withdraws its margin before it exits, the keeper finishes its cycle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/.run"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
SETTINGS_FILE="${SERVICES_ENV_FILE:-$RUN/services.env}"
STOP_WAIT="${STOP_WAIT:-90}"
KEEP_AWAKE="${KEEP_AWAKE:-1}"
SERVICES=(keeper maker)

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

node_bin() {
  local bin
  bin="${NODE_BIN:-$(command -v node || true)}"
  if [ -z "$bin" ]; then
    echo "node is not on PATH (Node 22 is needed)" >&2
    exit 1
  fi
  echo "$bin"
}

pid_of() {
  local file="$RUN/$1.pid"
  [ -f "$file" ] && cat "$file" || true
}

# Running, and really our service (not a reused pid).
running() {
  local pid
  pid="$(pid_of "$1")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q "src/main.ts run"
}

upper() {
  echo "$1" | tr '[:lower:]' '[:upper:]'
}

# Drops one pair of matching quotes around a value.
unquote() {
  local value="$1"
  case "$value" in
    \"*\" | \'*\') [ "${#value}" -ge 2 ] && value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "$value"
}

# The value of NAME in an env-style file (last one wins), or nothing.
file_value() {
  local file="$1" name="$2"
  [ -f "$file" ] || return 0
  unquote "$(grep -E "^(export )?$name=" "$file" | tail -n 1 | cut -d= -f2- || true)"
}

# NAME=value lines from the settings file that belong to this service, minus anything the shell already
# sets. Keys and other secrets are refused: they belong in .env.
settings_for() {
  local svc="$1" prefix line name value
  prefix="$(upper "$svc")_"
  [ -f "$SETTINGS_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#export }"
    case "$line" in '' | '#'*) continue ;; esac
    name="${line%%=*}"
    value="$(unquote "${line#*=}")"
    case "$name" in "$prefix"* | MONAD_*) ;; *) continue ;; esac
    case "$name" in
      *PRIVATE_KEY* | *SECRET* | *TOKEN* | *MNEMONIC*)
        echo "$svc: refusing $name from $SETTINGS_FILE: secrets stay in $ENV_FILE" >&2
        continue
        ;;
    esac
    [ -n "${!name+set}" ] && continue
    printf '%s=%s\n' "$name" "$value"
  done <"$SETTINGS_FILE"
}

# The value a start would give NAME: the shell, then the settings file, then .env.
effective() {
  local name="$1" value
  if [ -n "${!name+set}" ]; then
    echo "${!name}"
    return
  fi
  value="$(file_value "$SETTINGS_FILE" "$name")"
  [ -n "$value" ] || value="$(file_value "$ENV_FILE" "$name")"
  echo "$value"
}

mode_of() {
  local var
  var="$(upper "$1")_ENABLED"
  if [ "$(effective "$var")" = "1" ]; then echo "live"; else echo "dry run"; fi
}

config_one() {
  local svc="$1" var
  var="$(upper "$svc")_ENABLED"
  echo "$svc: $(mode_of "$svc") ($var=$(effective "$var"))"
  echo "  keys and RPC from: $ENV_FILE$([ -f "$ENV_FILE" ] || echo " (missing)")"
  echo "  settings from: $SETTINGS_FILE$([ -f "$SETTINGS_FILE" ] || echo " (missing)")"
  settings_for "$svc" | sed 's/^/    /'
}

start_one() {
  local svc="$1" log="$RUN/$1.log" node
  if running "$svc"; then
    echo "$svc: already running (pid $(pid_of "$svc"))"
    return 0
  fi
  node="$(node_bin)"
  mkdir -p "$RUN"
  if [ ! -f "$ENV_FILE" ]; then
    echo "$svc: warning: $ENV_FILE not found, so only the shell's variables apply"
  fi
  local mode settings=()
  mode="$(mode_of "$svc")"
  while IFS= read -r line; do settings+=("$line"); done < <(settings_for "$svc")
  if [ "$mode" != "live" ]; then
    echo "$svc: WARNING: starting as a DRY RUN: it will send no transaction."
    echo "$svc:   For live, set $(upper "$svc")_ENABLED=1 in $SETTINGS_FILE (see ops/services.env.example)."
  fi
  # The services import @hunch-book/shared's build output.
  (cd "$ROOT" && pnpm --filter @hunch-book/shared build >/dev/null)
  echo "--- start $(date -u +%Y-%m-%dT%H:%M:%SZ) ($mode)" >>"$log"
  (
    cd "$ROOT/services/$svc"
    detached env "$(upper "$svc")_ENV_FILE=$ENV_FILE" ${settings[@]+"${settings[@]}"} \
      nohup "$node" --import tsx src/main.ts run >>"$log" 2>&1 </dev/null &
    echo $! >"$RUN/$svc.pid"
  )
  sleep 3
  if running "$svc"; then
    echo "$svc: started, $mode (pid $(pid_of "$svc")), log $log"
    keep_awake "$svc"
  else
    echo "$svc: exited right away; last lines of $log:"
    tail -n 20 "$log"
    rm -f "$RUN/$svc.pid"
    return 1
  fi
}

# Runs a command in a new session (no controlling terminal, its own process group), so signals sent to
# the caller's group never reach it. The pid stays the same: setsid and perl exec the command.
detached() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@"
  else
    perl -MPOSIX -e 'POSIX::setsid(); exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!"' "$@"
  fi
}

# macOS only: hold off idle and system sleep for as long as the service's process lives.
keep_awake() {
  local svc="$1"
  [ "$KEEP_AWAKE" = "1" ] || return 0
  command -v caffeinate >/dev/null 2>&1 || return 0
  detached caffeinate -is -w "$(pid_of "$svc")" >/dev/null 2>&1 </dev/null &
  echo "$svc: keeping this Mac awake while it runs (KEEP_AWAKE=0 to skip)"
}

# Foreground: the service replaces this shell, with the same settings a start would give it. For
# launchd (ops/launchd), which supervises the process itself. Assumes packages/shared is built.
exec_one() {
  local svc="$1" node settings=()
  node="$(node_bin)"
  while IFS= read -r line; do settings+=("$line"); done < <(settings_for "$svc")
  echo "--- exec $(date -u +%Y-%m-%dT%H:%M:%SZ) ($(mode_of "$svc"))"
  cd "$ROOT/services/$svc"
  exec env "$(upper "$svc")_ENV_FILE=$ENV_FILE" ${settings[@]+"${settings[@]}"} "$node" --import tsx src/main.ts run
}

stop_one() {
  local svc="$1" pid waited=0
  if ! running "$svc"; then
    echo "$svc: not running"
    rm -f "$RUN/$svc.pid"
    return 0
  fi
  pid="$(pid_of "$svc")"
  kill -TERM "$pid"
  echo -n "$svc: stopping (pid $pid)"
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$STOP_WAIT" ]; then
      echo
      echo "$svc: still running after ${STOP_WAIT}s. Check its log; to force: kill -KILL $pid"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
    echo -n "."
  done
  echo " stopped"
  rm -f "$RUN/$svc.pid"
}

health_file() {
  local svc="$1" var value
  var="$(upper "$svc")_HEALTH_FILE"
  value="${!var:-}"
  if [ -z "$value" ] && [ -f "$ENV_FILE" ]; then
    value="$(grep -E "^(export )?$var=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d "\"'" || true)"
  fi
  echo "${value:-$ROOT/services/$svc/health.json}"
}

status_one() {
  local svc="$1" file
  if running "$svc"; then
    echo "$svc: running (pid $(pid_of "$svc"), up $(ps -p "$(pid_of "$svc")" -o etime= | tr -d ' '); a start now would be $(mode_of "$svc"))"
  else
    echo "$svc: stopped"
  fi
  file="$(health_file "$svc")"
  if [ -f "$file" ]; then
    "$(node_bin)" -e '
      const h = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const pick = ["updatedAt", "status", "enabled", "lastCycleAt", "monBalance", "lowBalance", "openOrders", "lastQuoteAt", "lastError"];
      for (const k of pick) if (h[k] !== undefined) console.log(`  ${k}: ${typeof h[k] === "object" ? JSON.stringify(h[k]) : h[k]}`);
    ' "$file"
  else
    echo "  no health file yet ($file)"
  fi
}

[ $# -ge 1 ] || usage
command="$1"
target="${2:-all}"
case "$target" in
  keeper | maker) targets=("$target") ;;
  all) targets=("${SERVICES[@]}") ;;
  *) usage ;;
esac

case "$command" in
  start) for s in "${targets[@]}"; do start_one "$s"; done ;;
  stop) for s in "${targets[@]}"; do stop_one "$s"; done ;;
  restart) for s in "${targets[@]}"; do stop_one "$s" && start_one "$s"; done ;;
  status) for s in "${targets[@]}"; do status_one "$s"; done ;;
  config) for s in "${targets[@]}"; do config_one "$s"; done ;;
  exec)
    [ "$target" != "all" ] || usage
    exec_one "$target"
    ;;
  logs)
    [ "$target" != "all" ] || usage
    mkdir -p "$RUN"
    touch "$RUN/$target.log"
    tail -n 50 -F "$RUN/$target.log"
    ;;
  *) usage ;;
esac
