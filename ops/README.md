# Running the keeper and the maker

Hunch Book has two long-running services, both open source and both run from published addresses
(`wallets` in [`deployments/monad-testnet.json`](../deployments/monad-testnet.json)):

| Service | What it does | Docs |
|---|---|---|
| Keeper (`services/keeper`) | Graduates pools, pushes token claims and pool payouts, settles and voids markets | [README](../services/keeper/README.md) |
| Maker (`services/maker`) | Quotes graduated markets on Kuru's order book | [README](../services/maker/README.md) |

Both start as a **dry run**: they read the chain, log what they would send, and send nothing. Sending
needs `KEEPER_ENABLED=1` or `MAKER_ENABLED=1` and the matching key. Both keep working from the chain
alone, so a restart never loses anything (the keeper's state file only saves it from scanning old logs
again).

Rules for every host:

- **One copy of each service per key.** Two keepers or two makers on one key race for nonces, and two
  makers would quote against each other. Do not run a service locally and on Railway at the same time.
- **Keys by name only.** Each service reads its own key from the environment (`KEEPER_PRIVATE_KEY`,
  `MAKER_PRIVATE_KEY`). Never put a key in a file that is committed, in a command line, or in a log.
- **Give the maker time to stop.** On SIGTERM it cancels every order and withdraws its margin before it
  exits; every setup below waits 90 seconds for it.

## On this machine

Node 22 and pnpm, from the repository root:

```sh
pnpm install
cp ops/services.env.example .run/services.env      # once: live settings (not keys); edit the series path
bash scripts/run-local-services.sh config          # what a start would use, live or dry run
bash scripts/run-local-services.sh start           # both; or: start keeper / start maker
bash scripts/run-local-services.sh status          # running or not, plus the health snapshot
bash scripts/run-local-services.sh logs keeper     # follow one log (Ctrl-C leaves)
bash scripts/run-local-services.sh stop            # SIGTERM, then waits up to 90 s
bash scripts/run-local-services.sh restart maker
```

The script runs each service in the background, in a session of its own (so closing the terminal that
started it does not stop it), keeps pid and log files in `.run/` (gitignored), and builds
`packages/shared` first. Each service loads the repository's `.env` (or the file in `ENV_FILE`) itself
and takes only its own variables, so neither process holds the other's key.

Settings that are not secrets live in `.run/services.env` (or the file in `SERVICES_ENV_FILE`);
[`services.env.example`](./services.env.example) is the testnet setup. A variable set in your shell wins
over that file, and that file wins over `.env`. The script refuses keys and tokens there. To send
transactions, `KEEPER_ENABLED=1` or `MAKER_ENABLED=1` must be set in one of those places; otherwise
`start` prints a warning that the service runs as a dry run, and `status` shows `enabled: false`.

On macOS, `start` also keeps the Mac awake while a service runs (`caffeinate -is`, tied to the
service's pid; `KEEP_AWAKE=0` skips it). A closed laptop lid still sleeps, and a sleeping Mac stops
both services. For a machine that should keep them running, use launchd (below) or a host.

## macOS launchd

Two agent templates: [`launchd/xyz.playhunch.book.keeper.plist`](./launchd/xyz.playhunch.book.keeper.plist)
and [`launchd/xyz.playhunch.book.maker.plist`](./launchd/xyz.playhunch.book.maker.plist). They start at
login, restart after a crash, write to `.run/<service>.log`, and serve health on ports 8781 (keeper) and
8782 (maker). Each runs `scripts/run-local-services.sh exec <service>`, so it takes the same settings as
a manual start: create `.run/services.env` first (above), or both run as a dry run. Install, from the
repository root:

```sh
pnpm install && pnpm --filter @hunch-book/shared build
mkdir -p .run ~/Library/LaunchAgents
for svc in keeper maker; do
  sed -e "s#__REPO__#$PWD#g" -e "s#__NODE__#$(command -v node)#g" \
    "ops/launchd/xyz.playhunch.book.$svc.plist" > "$HOME/Library/LaunchAgents/xyz.playhunch.book.$svc.plist"
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/xyz.playhunch.book.$svc.plist"
done
```

Check and stop:

```sh
launchctl print "gui/$(id -u)/xyz.playhunch.book.keeper" | head -20   # state, pid, last exit
curl -s localhost:8781/health                                           # keeper health
curl -s localhost:8782/health                                           # maker health
launchctl bootout "gui/$(id -u)/xyz.playhunch.book.maker"              # SIGTERM; SIGKILL after 90 s
```

`bootout` also stops it starting at the next login. To start it again, run the `bootstrap` line. After
pulling new code, `launchctl kickstart -k "gui/$(id -u)/xyz.playhunch.book.keeper"` restarts it (rebuild
`packages/shared` first if it changed).

## Railway

Each service has a `Dockerfile` (Node 22, pnpm through corepack, installs only that service and
`packages/shared`, runs as the non-root `node` user, `tsx src/main.ts run` as a single process) and a
`railway.json`: Dockerfile build, health check at `/health`, one replica, no overlap between an old
and a new deploy (two copies must never run at once), restart on failure, and time to stop (90 seconds
for the maker, 30 for the keeper). Both images serve health on port 8080 and keep their files in `/data`.

With the Railway CLI (`npm i -g @railway/cli`), from the repository root:

```sh
railway login
railway init --name hunch-book            # or `railway link` to an existing project
railway add --service keeper
railway add --service maker
```

In the Railway dashboard, for each service, set **Settings > Config-as-code > Railway config file** to
`/services/keeper/railway.json` and `/services/maker/railway.json`. (Without it, set the variable
`RAILWAY_DOCKERFILE_PATH=services/keeper/Dockerfile`, or the maker's, and the health check by hand.)

Variables, by name. Values for keys come from stdin, so they never sit in shell history:

```sh
# keeper
railway variable set --service keeper KEEPER_NETWORK=monad-testnet PORT=8080 KEEPER_MIN_MON=0.5
grep '^KEEPER_PRIVATE_KEY=' .env | cut -d= -f2- | railway variable set --service keeper --stdin KEEPER_PRIVATE_KEY
# optional: MONAD_TESTNET_RPC, KEEPER_ALERT_WEBHOOK, INDEXER_URL, PYTH_API_KEY (same way)

# maker
railway variable set --service maker MAKER_NETWORK=monad-testnet PORT=8080
grep '^MAKER_PRIVATE_KEY=' .env | cut -d= -f2- | railway variable set --service maker --stdin MAKER_PRIVATE_KEY
```

A volume keeps the keeper's scan cursors across deploys (optional; without it the keeper rescans):

```sh
railway service link keeper
railway volume add --mount-path /data
```

Deploy (uploads the checkout without anything gitignored, so `.env` and `internal/` never leave the
machine), then watch:

```sh
railway up --service keeper --detach
railway up --service maker --detach
railway service logs --service keeper
```

Both run as a dry run until you set `KEEPER_ENABLED=1` (or `MAKER_ENABLED=1`) on the service; setting a
variable redeploys it. To stop safely, remove the deployment with `railway down --service maker` (or set
the kill switch back to `0`): Railway sends SIGTERM and waits `drainingSeconds` before it kills the
container.

## Gas budgets

Monad charges for a transaction's **gas limit**, not the gas it uses. Both services simulate each
transaction first and set the limit to the estimate plus 10%. On Monad testnet the gas price has been
about 100 gwei (102 to 103 gwei on our transactions so far), so 1,000,000 gas costs about 0.1 MON.

Keeper (the keeper README's gas section links each transaction):

| Action | Gas | MON at 100 gwei |
|---|---|---|
| `graduate()`, creating the Kuru book (charged on testnet, market #1) | 1,721,637 | about 0.17 |
| `claimTokensFor`, per staker (charged on testnet: 918,908 for 11) | about 84,000 | about 0.008 |
| `claimTokensFor`, a batch of 50 | about 4,200,000 | about 0.42 |
| `voidIfExpired()` (gas used on a local anvil chain) | 84,433 | under 0.01 |
| `settle` (gas used on anvil, with a mock resolver) | about 150,000, plus the real resolver's reads | about 0.015 and up |

So graduating a market with 50 stakers and pushing their tokens costs the keeper about 0.6 MON; the
settlement cost on testnet is measured once the first market settles. Keep at least `KEEPER_MIN_MON` (0.5 by default) plus the next few markets' budget in the
keeper wallet; below the minimum it logs `low-mon`, its health shows `warn`, and the webhook is alerted.

Maker, charged on testnet (see the maker README): the first quote on a market, with approvals and
minting, about 0.15 MON; each requote (one `batchUpdate`) about 0.07 MON. It requotes after a fill, when
fair value or the best price moves by the requote threshold, and at most once per heartbeat (5 minutes)
for smaller changes. At one requote every 5 minutes a market costs about 20 MON a day; a quiet market
costs far less. It warns below 0.5 MON.

## Reading health

Each service writes a JSON snapshot after every cycle (keeper: `services/keeper/health.json`, maker:
`services/maker/health.json`; `/data/...` in the containers), and serves it at `GET /health` when its
health port is set.

```sh
curl -s localhost:8781/health | jq '{status, enabled, lastCycleAt, monBalance, markets, lastError}'
curl -s localhost:8781/health | jq '.jobs.settle'      # last run, last action with explorer link, last error
curl -s localhost:8782/health | jq '{lastQuoteAt, openOrders, monBalance, lastError}'
```

What to look at:

| Sign | Means | Do |
|---|---|---|
| `lastCycleAt` is minutes old | The process is stuck or the RPC is down | Read the log; restart |
| keeper `status: "warn"` / `lowBalance: true`, or maker `low-mon` lines | MON is low | Top up the wallet |
| keeper `jobs.<job>.lastError` | One market or job failed; the others carry on | Read the `job-error` line in the log |
| keeper `settle-later` lines that keep repeating for one market | The resolver will not answer yet (or ever: see the reason) | Nothing, unless the reason says the market can never settle; it then voids at its deadline |
| keeper `book-request` lines (mainnet) | A pool met its rule and needs Kuru to create its book | Send the logged `deployProxy` parameters to Kuru |
| maker `openOrders: 0` on a graduated market | It is not quoting | Read its `quote` and `tx-skipped` lines |

## Stopping safely

- **Keeper**: stop it any time (SIGTERM, Ctrl-C, `run-local-services.sh stop`, `launchctl bootout`,
  removing the Railway deployment). It finishes the cycle it is in and exits; the next start picks every
  job up again from the chain.
- **Maker**: always stop it with SIGTERM and give it 90 seconds: it cancels every order of its own on
  every Hunch Book book and withdraws its margin before it exits. A second signal exits at once and can
  leave orders resting. If it was killed, clear its orders with
  `MAKER_ENABLED=1 pnpm --filter @hunch-book/maker cancel-all` (it finds them on the books, no local state
  needed).

## Watching it from outside

The [watchdog](../services/watchdog) checks the protocol from the chain every 30 minutes on GitHub
Actions (`.github/workflows/liveness.yml`): vault solvency, YES and NO supply, settlement lag,
graduations about to be missed, and both services' MON balances. Any problem opens one issue
labelled `liveness`, which closes itself when the next run is healthy.

To have it check the services' health too, make the `/health` endpoints reachable from the internet
(Railway gives each service a public URL) and set the repository variables `KEEPER_HEALTH_URL` and
`MAKER_HEALTH_URL`. For alerts beyond GitHub notifications, set the `WATCHDOG_WEBHOOK` secret.
Run the same checks by hand with `pnpm --filter @hunch-book/watchdog check`.
