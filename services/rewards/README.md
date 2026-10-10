# Hunch Book rewards

Status: **building**, dry run only. A CLI that scores makers on the order books of Hunch Book markets
(V-5: Kuru v1 books and Hunch Book's own order books, on every stack), credits referrers from the fees
their referred users paid on every stack's vault (C-8), and writes a MerkleDistributor
epoch file with every account's amount and proof. It reads the chain and writes files; it never sends a
transaction. Formulas, files and steps: [docs/REWARDS.md](../../docs/REWARDS.md).

```sh
pnpm --filter "@hunch-book/sdk..." build
pnpm rewards sample --from <block> --to <block> [--every 200] [--check] --out samples.jsonl
pnpm rewards makers --samples samples.jsonl --pool <USDC per market> --out makers.json
pnpm rewards referrals --from <block> --to <block> [--share-bps 2000] --out referrals.json
pnpm rewards epoch --makers makers.json --referrals referrals.json --out epoch.json
```

Hunch Book's own maker bot is excluded from maker rewards and labelled in every output; its share is not
redistributed.

| File | What it does |
|---|---|
| [`src/orders.ts`](./src/orders.ts) | rebuilds each maker's resting orders from the book's events (Kuru v1's, which Hunch order books share) |
| [`src/score.ts`](./src/score.ts) | the maker-reward formula, in whole numbers |
| [`src/referrals.ts`](./src/referrals.ts) | the referral formula |
| [`src/epoch.ts`](./src/epoch.ts) | the epoch file and its tree (the SDK's `buildRewardTree`) |
| [`src/sample.ts`](./src/sample.ts), [`src/sources.ts`](./src/sources.ts) | chain and indexer reads |

```sh
pnpm --filter @hunch-book/rewards test
```
