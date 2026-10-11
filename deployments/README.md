# @hunch-book/deployments

The only source of Hunch Book contract addresses. Every reader (the app, the indexer, the bots, the
SDK and the docs) loads them from these files.

| File | Network |
|---|---|
| `monad-testnet.json` | Monad testnet, chain id 10143 |
| `monad-mainnet.json` | Monad mainnet, chain id 143 (filled in by the mainnet deploy) |

```ts
import testnet from "@hunch-book/deployments/monad-testnet.json" with { type: "json" };

console.log(testnet.hunchBook.factory);
```

A file can hold several stacks (a factory with its vault, graduator, router and periphery). The
primary stack sits under `hunchBook`, extra ones under `stacks`, and `defaultStack` names the one new
markets go to (the primary stack when absent). Kuru is the venue for every new market:

| Stack in `monad-testnet.json` | Books on | Status |
|---|---|---|
| `hunchBook` (primary) | Kuru v1, created inside `graduate()` | new markets go here |
| `stacks.kuruV2` | Kuru v2, once Kuru creates each book | its pools wait for Kuru to create their books |
| `stacks.hunch` | Hunch Book's own order book, our fallback | no new markets: creation is paused; its earlier markets run to settlement |

`monad-mainnet.json` gets the Kuru stack when the mainnet deploy runs (planned). There, Kuru's owner creates
each YES/USDC book and anyone registers it with the Graduator.

Every address and deploy transaction is checkable on the explorer named in each file. Hunch Book:
<https://book.playhunch.xyz>. MIT licensed.
