# Watchdog: liveness checks (roadmap O-6)

Reads the chain and answers one question: is Hunch Book healthy right now? It holds no key and sends
no transaction. It reads every stack in the deployments file (testnet: the primary one, `kuruV2` and
`hunch`, where new markets go) at one block: each stack's vault is checked on its own, and every
stack's markets are checked.

| Check | Ok | Warn | Fail |
|---|---|---|---|
| Solvency (each stack's vault) | vault USDC balance at least `totalObligations()` | | balance below obligations, by any amount |
| Supply | for every graduated, unsettled market: YES supply = NO supply = complete sets | | any difference |
| Settlement | settled within 2 hours of close (touch templates 3 and 4: after their 24-hour challenge period) | more than 2 hours late | more than 24 hours late |
| Void | | | past the settlement deadline and still not voided |
| Graduation | | a pool meets its rule and locks within 30 minutes, but has not graduated | |
| Keeper gas | at least 1 MON | below 1 MON | below 0.3 MON |
| Maker gas | at least 2 MON | below 2 MON | below 0.5 MON |
| Keeper and maker health (when their URLs are set) | last cycle within 10 minutes | endpoint did not answer | last cycle older than 10 minutes |

Block-clock markets (Perpl templates) are timed with the block time measured over the last 10,000
blocks.

## Run it

```bash
pnpm --filter @hunch-book/watchdog check                        # testnet, prints one JSON line per check
pnpm --filter @hunch-book/watchdog check --markdown report.md   # also writes a Markdown table
```

Exit code: 0 ok, 1 warn, 2 fail, 3 the check itself could not run (for example the RPC failed).

| Variable | Default | Meaning |
|---|---|---|
| `WATCHDOG_NETWORK` | `monad-testnet` | `monad-testnet` or `monad-mainnet` |
| `WATCHDOG_RPC_URL` | `MONAD_TESTNET_RPC` / `MONAD_MAINNET_RPC`, then the public RPC | Where to read |
| `KEEPER_HEALTH_URL`, `MAKER_HEALTH_URL` | none | The services' `/health` endpoints |
| `WATCHDOG_WEBHOOK` | none | Receives `POST {level, text}` whenever the result is not ok |

## Alerts to a phone

`.github/workflows/liveness.yml` runs the checks every 30 minutes on GitHub Actions. A warning or a
failure opens one issue labelled `liveness` and keeps its body up to date; the issue closes itself
when everything is healthy again. GitHub's mobile app notifies watchers of new issues.

For a push alert outside GitHub, set the `WATCHDOG_WEBHOOK` repository secret to any endpoint that
accepts a JSON POST (for example an ntfy.sh topic or a Telegram bot relay). To include the services'
health, expose their `/health` endpoints (see [ops/README.md](../../ops/README.md)) and set the
`KEEPER_HEALTH_URL` and `MAKER_HEALTH_URL` repository variables.
