# Hunch Book notifier

Status: **building**. A Telegram bot that tells people when a market they watch graduates, settles,
voids or moves a lot on its book, and when a wallet they watch has winnings to collect. Without a
token, or with `NOTIFIER_ENABLED` off, it is a dry run that prints every message.

```sh
pnpm --filter @hunch-book/notifier once    # one cycle against Monad testnet, printed
pnpm --filter @hunch-book/notifier start   # keep running
pnpm --filter @hunch-book/notifier test
```

Commands, events, settings, deployment and logs: [docs/NOTIFICATIONS.md](../../docs/NOTIFICATIONS.md).

| File | What |
|---|---|
| `src/config.ts` | settings from the environment, the kill switch, `.env` loading |
| `src/markets.ts` | market states from the chain or the indexer, and wallet positions |
| `src/events.ts` | what changed between two cycles, and what a wallet can collect |
| `src/messages.ts` | every message's text |
| `src/commands.ts` | `/start`, `/watch`, `/unwatch`, `/list` |
| `src/store.ts` | subscriptions in a JSON file |
| `src/state.ts` | what is remembered across restarts |
| `src/telegram.ts` | the Bot API client (long polling) and the dry-run printer |
| `src/notifier.ts` | one cycle, and the command loop |
| `src/health.ts`, `src/log.ts` | health snapshot and JSON logs, as in the keeper |
