# read-markets

The smallest useful Hunch Book script, on [`@hunch-book/sdk`](../../packages/sdk): it lists the markets
(rule, phase, chance of YES, pool), then reads the first trading market's Kuru book and quotes 5 USDC of
YES against it. Read-only: no wallet, no key.

```sh
pnpm install
pnpm --filter "@hunch-book/sdk..." build
pnpm --filter @hunch-book/example-read-markets start
NETWORK=monad-mainnet pnpm --filter @hunch-book/example-read-markets start   # once mainnet is deployed
```

`RPC_URL` points it at another RPC.
