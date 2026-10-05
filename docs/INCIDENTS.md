# Incidents

This is Hunch Book's incident log, shown on the app's status page. Anything that stops a market,
delays a settlement or a payout, or puts funds at risk is logged here, newest first. Each entry has a
`## date: title` heading, then what happened, who was affected, what was done (with links to the
transactions), and what changes so it does not happen again.

## 2026-10-05: keeper and maker stopped for 22 hours, market #1 settled late

**What happened.** On Monad testnet, Hunch Book's keeper and maker bot run as background processes on one
machine. Both received SIGTERM at 20:59 UTC on 2026-10-04, then a second SIGTERM 11 seconds later, the
signature of the processes being stopped together with the shell session that started them. The keeper
finished its cycle and exited; the maker exited before it could cancel its two resting orders. Neither
was restarted until 19:43 UTC on 2026-10-05, and that first restart came up as a dry run, because the
setting that turns sending on lived in the shell that had started them before, not in a file. They ran
live from 19:45 UTC.

**Who was affected.**

- Market #1 [0x2A44…3982](https://testnet.monadscan.com/address/0x2A44B99014cF73065BFb89197a08DE09D18d3982)
  closed at 00:56 UTC on 2026-10-05 and was not settled for 18 hours 49 minutes. Its settlement deadline
  is 7 days after close, so it never risked a void. Every token in it is held by our own wallets.
- A touch market [0xD45e…1000](https://testnet.monadscan.com/address/0xD45e536b84169983B908aF3259c10992Dd8A1000)
  could have been proved YES about 22 hours earlier.
- Two maker orders stayed on market #1's Kuru book after close. No one traded against them.
- Nothing was lost: settlement and redemption never depend on the keeper (anyone can call `settle`), and
  no funds moved without their owner.

**What was done.**

- The keeper settled market #1 NO at 19:45 UTC ([tx](https://testnet.monadscan.com/tx/0x2d53ad4c3cb322c34447839a8beea8cc3dc208c1c8fa1930fc06cab96b20fc72))
  and proved the touch market YES ([tx](https://testnet.monadscan.com/tx/0xd1ec7102a1660a963dd1fa0442394168cf9b9f488ed73bc763c69adae40707f4)).
- The maker redeemed its NO tokens ([tx](https://testnet.monadscan.com/tx/0x40b82c5fa558c48297b3bfc635ab952f11052f30034d62b8df1de751b768e518)).
- The liveness watchdog had opened a warning issue at 11:44 UTC ("closed 10 h 47 min ago and not settled
  yet"). It was closed after the settlement.

**What changes.**

- `scripts/run-local-services.sh` now starts each service in a session of its own, so the shell or tool
  session that ran `start` can no longer take it down when it ends.
- Live settings (`KEEPER_ENABLED`, `MAKER_ENABLED` and the rest that are not secrets) live in
  `.run/services.env`; `start` warns loudly when a service would run as a dry run, and `config` shows
  what a start would use. launchd runs the same script, so both paths take the same settings.
- On macOS, `start` keeps the machine awake while the services run.
- The services still run on one machine. Moving them to a host that restarts them on its own
  ([ops/README.md](https://github.com/rajkaria/hunch-book/blob/main/ops/README.md)) is the lasting fix.
