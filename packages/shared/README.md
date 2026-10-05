# @hunch-book/shared

The pieces every Hunch Book reader shares: contract ABIs (generated from the Foundry build), the
deployment addresses for Monad testnet and mainnet (from
[`@hunch-book/deployments`](https://github.com/rajkaria/hunch-book/tree/main/deployments)), chain
configs, template ids and parameter encoders, and the types the contracts use (`Phase`, `Side`,
`Outcome`).

Most people want [`@hunch-book/sdk`](https://github.com/rajkaria/hunch-book/tree/main/packages/sdk),
which builds on this.

```ts
import { deployments, marketAbi, Phase } from "@hunch-book/shared";

const testnet = deployments["monad-testnet"];
console.log(testnet.hunchBook.factory);
```

Hunch Book: prediction markets on Monad that start as USDC pools, graduate to Kuru's onchain order book
and settle by reading the chain. <https://book.playhunch.xyz>. MIT licensed.
