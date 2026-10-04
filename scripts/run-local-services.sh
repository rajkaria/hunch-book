#!/usr/bin/env bash
# Runs Hunch Book's keeper and maker bot in the background on this machine.
#
#   bash scripts/run-local-services.sh start   [keeper|maker|all]
#   bash scripts/run-local-services.sh stop    [keeper|maker|all]
#   bash scripts/run-local-services.sh restart [keeper|maker|all]
#   bash scripts/run-local-services.sh status  [keeper|maker|all]
#   bash scripts/run-local-services.sh logs    [keeper|maker]      (follows the log; Ctrl-C leaves)
#
# Pid and log files go in .run/ at the repository root (gitignored). Each service loads the repository's
# .env itself (or the file in ENV_FILE) and takes only its own variables (KEEPER_* or MAKER_*, plus
# MONAD_*), so neither process holds the other's key. Both run as a dry run unless KEEPER_ENABLED=1 or
# MAKER_ENABLED=1 is set in that file or in your shell.
#
# stop sends SIGTERM and waits (STOP_WAIT seconds, default 90): the maker cancels every order and
# withdraws its margin before it exits, the keeper finishes its cycle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/.run"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
STOP_WAIT="${STOP_WAIT:-90}"
SERVICES=(keeper maker)

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

node_bin() {
  local bin
  bin="$(command -v node || true)"
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
  # The services import @hunch-book/shared's build output.
  (cd "$ROOT" && pnpm --filter @hunch-book/shared build >/dev/null)
  echo "--- start $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"
  (
    cd "$ROOT/services/$svc"
    env "$(upper "$svc")_ENV_FILE=$ENV_FILE" nohup "$node" --import tsx src/main.ts run >>"$log" 2>&1 &
    echo $! >"$RUN/$svc.pid"
  )
  sleep 3
  if running "$svc"; then
    echo "$svc: started (pid $(pid_of "$svc")), log $log"
  else
    echo "$svc: exited right away; last lines of $log:"
    tail -n 20 "$log"
    rm -f "$RUN/$svc.pid"
    return 1
  fi
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
    echo "$svc: running (pid $(pid_of "$svc"), up $(ps -p "$(pid_of "$svc")" -o etime= | tr -d ' '))"
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
  logs)
    [ "$target" != "all" ] || usage
    mkdir -p "$RUN"
    touch "$RUN/$target.log"
    tail -n 50 -F "$RUN/$target.log"
    ;;
  *) usage ;;
esac
