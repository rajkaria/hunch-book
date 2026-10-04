# Notifications

Status: **building**. The notifier (`services/notifier`) runs and is tested; it is not deployed yet.
Without a Telegram bot token it runs as a dry run that prints every message it would send.

## What it does

A Telegram bot. People tell it which markets and wallets to watch, and it messages them when:

| Event | Who hears | When |
|---|---|---|
| Graduation | watchers of the market, and watchers of wallets that hold it | the pool became YES and NO tokens on its Kuru book |
| Settlement | the same | the resolver read the answer and the market settled YES or NO |
| Void | the same | no answer before the settlement deadline |
| Big move | the same | a graduated market's YES chance (the book's mid price) moved by `NOTIFIER_PRICE_MOVE_BPS` or more since the last move reported |
| Ready to collect | watchers of the wallet | a settled or voided market holds something for the wallet: winning tokens to redeem, tokens still to claim, or a pool payout |

Every message is plain text with two links: the market in the app and its contract on the explorer.

## Commands

| Command | What it does |
|---|---|
| `/start`, `/help` | what the bot does and its commands |
| `/watch <address or market link>` | watch a market or a wallet. The bot asks the factory (`isMarket`): a market address is watched as a market, anything else as a wallet. A link like `https://book.playhunch.xyz/m/0x…` works. |
| `/unwatch <address>`, `/unwatch all` | stop watching one thing, or everything |
| `/list` | what this chat watches |

One chat can watch up to `NOTIFIER_MAX_WATCHES_PER_CHAT` things (default 20).

## How it watches

Every `NOTIFIER_POLL_SECONDS` (default 30) the notifier reads every market's state in a few
multicalls: phase, outcome, whether it graduated, pool totals, the resolver's rule sentence and, for
graduated markets, Kuru's best bid and ask. With `INDEXER_URL` set it reads the same from the indexer
in one GraphQL query, and falls back to the chain if the indexer fails.

It compares that with the state it remembered from the last cycle, rather than scanning event logs.
Public Monad RPCs answer `eth_getLogs` for 100 blocks at a time, so a log scanner that falls behind or
restarts can miss events; a state comparison cannot. A restart reports, on its next cycle, everything
that changed while it was down, and nothing twice. A market seen for the first time gives no message.

For watched wallets it reads `stakeOf`, `claimableTokens`, `claimablePool` and both token balances in
every market (bounded by `NOTIFIER_MAX_WALLETS`, default 200) to decide who holds what and what is ready
to collect. Each "ready to collect" message is sent once per wallet and market.

Telegram commands arrive by long polling (`getUpdates`), so the bot needs no public URL or webhook.
Only one copy may poll a bot at a time: run one replica.

## Run it

Node 22 and pnpm. From the repository root:

```sh
pnpm install
pnpm --filter @hunch-book/shared build

pnpm --filter @hunch-book/notifier once     # one cycle, prints what it would send
pnpm --filter @hunch-book/notifier start    # keep running (dry run until enabled)

# Live: create a bot with @BotFather, put its token in the environment, then:
NOTIFIER_ENABLED=1 pnpm --filter @hunch-book/notifier start
```

For local runs the notifier also loads the repository's `.env` (or `NOTIFIER_ENV_FILE`, or
`--env-file <path>`), taking only `NOTIFIER_*`, `MONAD_*`, `TELEGRAM_BOT_TOKEN` and `INDEXER_URL`, and
never overriding a variable that is already set.

As a service: `services/notifier/Dockerfile` and `services/notifier/railway.json`, like the keeper's.
Mount a volume at `/data` so subscriptions and state survive a redeploy.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | none | The bot's token from @BotFather. Never printed; cut from every log line. |
| `NOTIFIER_ENABLED` | off | Kill switch. Only `1`, `true`, `yes` or `on` turns sending on. Off, or no token: dry run (messages printed, Telegram never called). |
| `NOTIFIER_NETWORK` | `monad-testnet` | `monad-testnet` or `monad-mainnet`. Picks `deployments/<network>.json`. |
| `NOTIFIER_RPC_URL` | network default | RPC override. Otherwise `MONAD_TESTNET_RPC` or `MONAD_MAINNET_RPC`, then the deployments file. |
| `INDEXER_URL` | none | The indexer's GraphQL endpoint. When set, market states come from it, with the chain as fallback. |
| `NOTIFIER_POLL_SECONDS` | `30` | Time between cycles (at least 5). |
| `NOTIFIER_PRICE_MOVE_BPS` | `1000` | A move of the book's YES chance by this many basis points (10 points) is a big move. |
| `NOTIFIER_APP_URL` | `https://book.playhunch.xyz` | Where market links point. |
| `NOTIFIER_SUBSCRIPTIONS_FILE` | `services/notifier/.subscriptions.json` | Who watches what. Gitignored. |
| `NOTIFIER_STATE_FILE` | `services/notifier/.notifier-state.json` | Last market states, messages sent, Telegram offset. Safe to delete. |
| `NOTIFIER_HEALTH_FILE` | `services/notifier/health.json` | Health snapshot after every cycle. |
| `NOTIFIER_HEALTH_PORT` | none | When set, the snapshot is also served at `GET /health`. |
| `NOTIFIER_MAX_WATCHES_PER_CHAT` | `20` | Watches per chat. |
| `NOTIFIER_MAX_WALLETS` | `200` | Watched wallets read per cycle. |

## Logs and health

Every stdout line is one JSON object: `start`, `dry-run`, `cycle`, `event`, `redeem-ready`,
`dry-run-message` (the full text, in dry run), `send-failed`, `indexer-failed`, `telegram-poll-failed`,
`cycle-failed`. The health snapshot has the mode (`live` or `dry-run`), the data source, cycles, the
last cycle time, markets, chats, watched wallets, messages sent and the last error.

## Privacy

The subscription file links Telegram chat ids to the addresses they watch. It stays on the server
(gitignored, on a private volume) and is never logged in full. Watching an address needs no proof that
you own it, because everything the bot says about it is public on chain anyway.

## Tests

`pnpm --filter @hunch-book/notifier test`: command parsing and replies, the subscription store and its
file, every event rule (first sighting, graduation, settlement, void, the move baseline, books only),
"ready to collect" for every kind of final market, message text and links, state round trips, the
config and its kill switch, the indexer read, and full cycles against a fake chain (who is told, and
that nothing is told twice).
