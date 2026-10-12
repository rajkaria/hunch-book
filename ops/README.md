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

**Mainnet next to testnet.** A second pair runs from the same checkout with its own run directory
(pid, log and settings file) and launchd prefix; [`services.mainnet.env.example`](./services.mainnet.env.example)
is its settings file (`KEEPER_NETWORK` and `MAKER_NETWORK` set to `monad-mainnet`, dry run until
checked). Off testnet the keeper's state and health files and the maker's health file are named after
the network by default, so the pairs share nothing but the keys, and nonces are per chain:

```sh
mkdir -p .run/mainnet && cp ops/services.mainnet.env.example .run/mainnet/services.env
RUN_DIR=$PWD/.run/mainnet LAUNCHD_PREFIX=xyz.playhunch.book.mainnet bash scripts/run-local-services.sh config
RUN_DIR=$PWD/.run/mainnet LAUNCHD_PREFIX=xyz.playhunch.book.mainnet bash scripts/run-local-services.sh start
```

On macOS, `start` also keeps the Mac awake while a service runs (`caffeinate -is`, tied to the
service's pid; `KEEP_AWAKE=0` skips it). A closed laptop lid still sleeps, and a sleeping Mac stops
both services. For a machine that should keep them running, use launchd (below) or a host.

## Always on: where the services run today

Settlement, graduation and payouts must not wait on a laptop. Since 2026-10-12 the services run on Railway
(project `hunch-book`), each from this repository's Dockerfiles, with a phone alert when anything stops.

| Railway service | Runs | Settings that differ from the defaults | Health |
|---|---|---|---|
| `keeper-mainnet` | the keeper on Monad mainnet | `KEEPER_NETWORK=monad-mainnet`, `KEEPER_BOOK_REQUEST_AT=0.5`, `KEEPER_JOBS_OFF=oracle,kuruFeeds,series`, `KEEPER_MIN_MON=1` | [/health](https://keeper-mainnet-production-3f1c.up.railway.app/health) |
| `keeper-testnet` | the keeper on Monad testnet | `KEEPER_NETWORK=monad-testnet`, `KEEPER_ORACLE_POKE_SECONDS=7200`, `KEEPER_SERIES_ENABLED=0` | [/health](https://keeper-testnet-production-df84.up.railway.app/health) |
| `maker-testnet` | the maker on Monad testnet | `MAKER_NETWORK=monad-testnet`, `MAKER_HEARTBEAT_SECONDS=21600`, `MAKER_REQUOTE_THRESHOLD=0.02`, `MAKER_POLL_SECONDS=20` (a requote every hour on every book cost about 17 MON a day, so it refreshes every 6 hours and on a 2-cent move) | [/health](https://maker-testnet-production.up.railway.app/health) |
| `watchdog-mainnet`, `watchdog-testnet` | the [watchdog](../services/watchdog), as a cron every 10 minutes | `WATCHDOG_NETWORK`, `WATCHDOG_WEBHOOK`, `KEEPER_HEALTH_URL`, `MAKER_HEALTH_URL` | its log |

The mainnet maker is not deployed: it stays a dry run until a Kuru book exists on mainnet and it holds USDC.
Every service runs from the same published wallets as before (`wallets` in the deployments files), so all of
its activity stays labelled as ours.

### Who rings when something stops

Four layers, each independent of the one before it:

1. **The service restarts itself.** Railway restarts a keeper or maker that crashes (up to 10 times in a
   row) and checks `/health` before it routes to a new deploy. Two copies never run at once (no overlap).
2. **The keeper reports what it sees.** `KEEPER_ALERT_WEBHOOK` gets every job error, a low MON balance, a
   market that cannot settle, a mainnet book request, and each settlement it sends. One alert per market and
   event at most every `KEEPER_ALERT_REPEAT_SECONDS` (6 hours on Railway).
3. **The watchdog checks from the outside every 10 minutes.** It reads the chain, not the keeper: vault
   solvency, YES and NO supply, settlement lag on every market, graduations about to be missed, both wallets'
   MON, and the keeper's and maker's `/health` (a last cycle older than the limit fails; a service left in dry
   run warns). Anything not ok goes to `WATCHDOG_WEBHOOK`.
4. **GitHub checks Railway.** The [liveness workflow](../.github/workflows/liveness.yml) runs the same check
   for both networks on GitHub's servers, so it still fires if Railway itself is down. GitHub runs scheduled
   workflows late (often hours apart), so it is the backstop, not the first alarm. It opens one issue per
   network and posts to the same webhook (the `WATCHDOG_WEBHOOK` repository secret).

**On a phone.** Both webhooks point at an [ntfy](https://ntfy.sh) topic. Install the ntfy app and subscribe
to the topic (its name is kept private: it is the value of `WATCHDOG_WEBHOOK` in Railway). The keeper and
the watchdog recognise an ntfy URL and send a short titled message: errors and failed checks ring as
urgent, warnings as high, a settlement as a normal notification. Any other URL (Slack, Discord, a JSON
endpoint) still gets the JSON payload.

**If every layer fails, nothing is lost.** `settle`, `graduate`, `claimTokensFor`, `claimPoolFor` and
`voidIfExpired` are permissionless. Anyone can run one keeper cycle from any machine with a funded key:

```sh
KEEPER_NETWORK=monad-mainnet KEEPER_ENABLED=1 pnpm --filter @hunch-book/keeper exec tsx src/main.ts once
```

A market that is not settled waits; its money stays in the vault until someone settles it, and a market
nobody settles voids at its settlement deadline and refunds every stake.

### Moving the keys to Railway

The services start keyless, as a dry run. To turn them on, from the repository root of a checkout that has
the keys in `.env` and is linked to the project (`railway link`, project `hunch-book`):

```sh
bash ops/railway-set-keys.sh          # copies KEEPER_PRIVATE_KEY and MAKER_PRIVATE_KEY through stdin; prints names only
```

Then, one service at a time: stop the local copy that signs with the same key (one copy per key, always),
check the dry run reads right (`/health` shows the published address and the expected markets), and turn it
on. Setting a variable redeploys the service:

```sh
RUN_DIR=$PWD/.run/mainnet LAUNCHD_PREFIX=xyz.playhunch.book.mainnet bash scripts/run-local-services.sh stop keeper
railway variable set --service keeper-mainnet KEEPER_ENABLED=1
launchctl bootout "gui/$(id -u)/xyz.playhunch.book.keeper"     # the local testnet keeper
railway variable set --service keeper-testnet KEEPER_ENABLED=1
launchctl bootout "gui/$(id -u)/xyz.playhunch.book.maker"      # the local testnet maker; it cancels its orders first
railway variable set --service maker-testnet MAKER_ENABLED=1
```

Do not switch a keeper over in the half hour around a market's close: let the running copy settle it first.

### Gas for the judging window and after

The keeper's wallet pays for every settlement, graduation and payout. On 2026-10-12 it held 15 MON on
mainnet and about 20 MON on testnet; the maker about 19 MON on testnet. The watchdog warns when the keeper
holds less than 1 MON and fails below 0.3 MON (the maker: 2 and 0.5), and the keeper alerts below
`KEEPER_MIN_MON`. A market still unsettled 2 hours after it can be settled is a warning, 24 hours a failure.
Top up the published address from any wallet; no restart is needed.

## macOS launchd

Two agent templates: [`launchd/xyz.playhunch.book.keeper.plist`](./launchd/xyz.playhunch.book.keeper.plist)
and [`launchd/xyz.playhunch.book.maker.plist`](./launchd/xyz.playhunch.book.maker.plist). They start at
login, restart after a crash, write to `.run/<service>.log`, serve health on ports 8781 (keeper) and
8782 (maker), and keep the Mac awake while the service runs (`caffeinate -is`; set `KEEP_AWAKE` to `0` in
the plist's `EnvironmentVariables` to skip). A closed lid still sleeps. Each runs `scripts/run-local-services.sh exec <service>`, so it takes the same settings as
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

While an agent is loaded, `scripts/run-local-services.sh` leaves its service alone (`start` and `stop`
print the `launchctl` line to use instead), so two copies never run at once; `status` still reports it.
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

A volume keeps the keeper's scan cursors across deploys (optional; without it the keeper rescans).
Railway mounts volumes as root while the images run as the `node` user, so set `RAILWAY_RUN_UID=0` on a
service with a volume, or its state and health writes fail with `EACCES`:

```sh
railway service link keeper
railway volume add --mount-path /data
railway variable set --service keeper RAILWAY_RUN_UID=0
```

The `railway.json` next to each Dockerfile holds the build and deploy settings. When a service's config file
path is not set in the dashboard, the same settings can be applied from the command line: `railway
environment edit` reads them as JSON on stdin (`{"services": {"<service id>": {"build": {...}, "deploy":
{...}}}}`). The watchdog's `railway.json` adds `"cronSchedule": "*/10 * * * *"` and `"restartPolicyType":
"NEVER"`: it runs once, checks, alerts and exits.

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
| keeper `book-request` lines (mainnet) | A pool met its rule, or is `KEEPER_BOOK_REQUEST_AT` of the way there, and needs Kuru to create its book | Send the logged `deployProxy` parameters to Kuru |
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

The [watchdog](../services/watchdog) checks the protocol from the chain: vault solvency, YES and NO supply,
settlement lag, graduations about to be missed, both services' MON balances and, when their URLs are set,
their `/health`. It runs in two places (see [Who rings when something stops](#who-rings-when-something-stops)):
every 10 minutes as a Railway cron, and on GitHub Actions (`.github/workflows/liveness.yml`) for both
networks, which GitHub schedules every 30 minutes but in practice runs hours apart. On GitHub any problem
opens one issue per network labelled `liveness`, which closes itself when that network is healthy again.

Repository settings the workflow reads: the variables `KEEPER_HEALTH_URL`, `MAKER_HEALTH_URL` (testnet) and
`KEEPER_HEALTH_URL_MAINNET`, `MAKER_HEALTH_URL_MAINNET`, and the secrets `WATCHDOG_WEBHOOK` (an ntfy topic
URL pushes to a phone), `WATCHDOG_RPC_URL` and `WATCHDOG_RPC_URL_MAINNET` (keyed RPCs, optional).
Run the same checks by hand with `WATCHDOG_NETWORK=monad-mainnet pnpm --filter @hunch-book/watchdog check`.
