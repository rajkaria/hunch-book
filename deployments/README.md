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

Every address and deploy transaction is checkable on the explorer named in each file. Hunch Book:
<https://book.playhunch.xyz>. MIT licensed.
