# Hunch Book data API

Status: **building**. The API is served by the app ([`apps/web/src/app/api/v1`](../apps/web/src/app/api/v1))
and reads Monad testnet. It is built on the [TypeScript SDK](./SDK.md); every value comes from the chain
or, where noted, from the [indexer](./INDEXER.md). The examples below are real responses, read from
Monad testnet on 2026-10-04 (the funding examples on 2026-10-05; trimmed where marked).

Base URL: `https://book.playhunch.xyz/api/v1` (the app's own origin; the network is the app's,
`NEXT_PUBLIC_HUNCH_NETWORK`).

| Endpoint | What it returns |
|---|---|
| [`GET /markets`](#get-markets) | every market, filtered and paged |
| [`GET /markets/{address}`](#get-marketsaddress) | one market in full, with the top of its book |
| [`GET /markets/{address}/trades`](#get-marketsaddresstrades) | fills on the market's Kuru book |
| [`GET /markets/{address}/evidence`](#get-marketsaddressevidence) | settlement evidence and its verification |
| [`GET /settlements`](#get-settlements) | the settlement archive: every finished market with the read that settled it |
| [`GET /stats`](#get-stats) | protocol totals and the vault's solvency |
| [`GET /feed`](#get-feed) | open markets as cards, for the main Hunch app and anyone else |
| [`GET /funding/{asset}`](#get-fundingasset) | what the market thinks about a Perpl perp's funding this period |
| [`GET /embed/m/{address}`](#embed) (outside `/api`) | a market card for an iframe |
| [`GET /embed/funding/{asset}`](#funding-card) (outside `/api`) | the funding answer as a card for an iframe, such as on Perpl |
| `GET /` | this list of endpoints |

## Conventions

- **JSON**, UTF-8. Amounts are exact decimal strings: USDC amounts end in `Usdc` (`"690"`, `"12.5"`);
  prices are USDC per whole token (`"0.399"`); token sizes are whole tokens (`"12.01923"`). Chances are
  basis points (`3835` is 38.35%), with a `percent` string. Raw onchain integers (block numbers, raw
  params) are decimal strings. Times are ISO 8601 UTC.
- **Block-clock markets** (Perpl templates 1 and 4) have their lock and close as block numbers;
  `lockAt` and `closeAt` are estimated from the block time measured over the last 10,000 blocks, and
  `estimated` is true.
- **CSV**: add `?format=csv` to any endpoint. Lists come back as one row per item; a single record
  (one market, evidence, stats) as `field,value` rows with nested fields joined by dots. Cells that a
  spreadsheet would run as a formula are prefixed with `'`.
- **CORS** is open for `GET` (`Access-Control-Allow-Origin: *`); `OPTIONS` answers the preflight.
- **Caching**: responses carry `Cache-Control` with `s-maxage` and `stale-while-revalidate`: 15 seconds
  for lists, details and the feed, 30 seconds for trades and stats, 60 seconds for evidence (5 minutes
  once a market has settled). Each server also keeps reads for 15 seconds and shares one read between
  concurrent requests, so bursts cost one round of RPC calls.
- **Errors** are `{ "error": "<one plain sentence>" }`, never cached: `400` for a bad query or address,
  `404` for an address that is not a market, `502` when the chain or the indexer does not answer.
- **Our own activity is labelled**: `createdByHunch` (the market's creator is one of Hunch Book's
  wallets), `makerIsHunchMaker` (the fill's maker is our maker bot, `wallets.maker` in the deployments
  file) and `traderIsHunch` (the taking wallet is ours). Stats split fills and volume the same way.

## GET /markets

| Query | Default | Meaning |
|---|---|---|
| `phase` | all | `pool`, `pool-locked`, `trading`, `closed`, `settled`, `voided`, or `open` (pool and trading) |
| `template` | all | a template id, 1 to 7 |
| `asset` | all | `BTC`, `ETH`, `MON`, `SOL`; matches the perp (`BTC`) and the feed (`BTC/USD`) |
| `limit` | 50 | 1 to 200 |
| `offset` | 0 | |

Newest first. `total` counts every market, `matching` those that pass the filters.

```json
{
  "network": "monad-testnet",
  "total": 1,
  "matching": 1,
  "offset": 0,
  "limit": 50,
  "markets": [
    {
      "id": 1,
      "address": "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "network": "monad-testnet",
      "url": "https://book.playhunch.xyz/m/0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "embedUrl": "https://book.playhunch.xyz/embed/m/0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "explorer": "https://testnet.monadscan.com/address/0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "template": { "id": 1, "name": "Perpl net funding" },
      "asset": "MON",
      "rule": "Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block 68058301 and block 68264005?",
      "phase": "trading",
      "phaseLabel": "Trading",
      "outcome": "unresolved",
      "chance": { "bps": 3835, "percent": "38.35%", "source": "book" },
      "pool": { "yesUsdc": "410", "noUsdc": "280", "totalUsdc": "690", "stakers": 11 },
      "book": {
        "address": "0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a",
        "bid": "0.368",
        "ask": "0.399",
        "mid": "0.3835",
        "spread": "0.031"
      },
      "window": {
        "clock": "block",
        "lock": "68058301",
        "close": "68264005",
        "lockAt": "2026-10-04T07:41:22.000Z",
        "closeAt": "2026-10-05T00:56:44.000Z",
        "estimated": true,
        "settleDeadline": "2026-10-15T07:35:04.000Z"
      },
      "graduated": true,
      "graduationRule": { "minPoolUsdc": "500", "minStakers": 10, "minChanceBps": 300, "maxChanceBps": 9700, "met": true },
      "tokens": {
        "yes": "0x9D6C40f96Fd7D7Ad7B16a4a53bb4707f693D270E",
        "no": "0x522CE8eBA8C2DF6F8df2FE090B5dF511579344f3"
      },
      "resolver": "0x4ec0077e30EA8B626C5AA087C586E60542150951",
      "creator": "0xD183a7daECF3d539683f37e1111558E3dFC210A8",
      "createdByHunch": true,
      "evidenceHash": null,
      "health": {
        "score": 93,
        "grade": "good",
        "parts": [
          { "name": "liquidity", "points": 46, "max": 50, "why": "Pool of 480 of 500 USDC and 8 of 10 stakers to graduate." },
          { "name": "time", "points": 17, "max": 20, "why": "Staking ends in 18 hours." },
          { "name": "source", "points": 30, "max": 30, "why": "Perpl's funding history is stored onchain at every block, so the answer is always readable." }
        ]
      }
    }
  ]
}
```

`health` is the market's health score ([HEALTH.md](./HEALTH.md)); the example's `health` is the golden
path pool (market #7), read on 2026-10-05 at 20:54 UTC, under an older market's fields. A settled or voided market has
`{ "score": null, "grade": "finished", "parts": [] }`.

`chance.source` is `pool` (the pool's split, `Y / T`), `book` (the mid of the Kuru book's best bid and
ask), `book-one-sided` (the one side with orders, as the onchain oracle reads it), `book-empty`,
`settled` (100% or 0%), `voided` (50%) or `empty` (a pool with no stakes). `rule` is the resolver's own
`describe()` sentence, the rule of record. `evidenceHash` is null until the market settles.

`?format=csv`:

```csv
id,address,template_id,template,asset,phase,outcome,chance_bps,chance_source,pool_yes_usdc,pool_no_usdc,pool_total_usdc,stakers,best_bid,best_ask,clock,lock,close,close_at,settle_deadline,created_by_hunch,health_score,rule,url
1,0x2A44B99014cF73065BFb89197a08DE09D18d3982,1,Perpl net funding,MON,trading,unresolved,8525,book,410,280,690,11,0.837,0.868,block,68058301,68264005,2026-10-05T00:56:44.000Z,2026-10-15T07:35:04.000Z,true,,"Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block 68058301 and block 68264005?",https://book.playhunch.xyz/m/0x2A44B99014cF73065BFb89197a08DE09D18d3982
```

(The two examples were read a few hours apart; the maker bot had moved its quotes.)

## GET /markets/{address}

Everything in the list entry, plus the decoded params, the caps, the book's top 20 levels on each side
and links to the market's trades and evidence. `404` when the factory does not know the address. A
snapshot market (template 7) also has `snapshotSource`: the label, unit and decimals of the value it
reads.

```json
{
  "id": 1,
  "address": "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
  "rule": "Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block 68058301 and block 68264005?",
  "phase": "trading",
  "chance": { "bps": 3835, "percent": "38.35%", "source": "book" },
  "params": {
    "kind": "perpl-funding",
    "templateId": 1,
    "params": { "perpId": "64", "startBlock": "68058301", "endBlock": "68264005", "threshold": "1500", "expectedScalingExp": 3 }
  },
  "caps": { "poolCapUsdc": "5000", "walletCapUsdc": "1000", "minStakeUsdc": "1", "creatorMinStakeUsdc": "5" },
  "book": {
    "address": "0xdFd060ac7d3b129261EaB2E3DDd6F76A877D104a",
    "bid": "0.368",
    "ask": "0.399",
    "mid": "0.3835",
    "spread": "0.031",
    "levels": {
      "bids": [{ "price": "0.368", "sizeYes": "20" }],
      "asks": [{ "price": "0.399", "sizeYes": "20" }],
      "block": "68070544"
    }
  },
  "links": {
    "trades": "https://book.playhunch.xyz/api/v1/markets/0x2A44B99014cF73065BFb89197a08DE09D18d3982/trades",
    "evidence": "https://book.playhunch.xyz/api/v1/markets/0x2A44B99014cF73065BFb89197a08DE09D18d3982/evidence"
  }
}
```

(Trimmed: the fields shared with the list entry are left out.)

## GET /markets/{address}/trades

| Query | Default | Meaning |
|---|---|---|
| `limit` | 100 | 1 to 500 fills, newest first |
| `blocks` | 1,000 | how many blocks the log scan reads, at most 5,000 |
| `fromBlock` | the last `blocks` | read `blocks` blocks from this block on, from Kuru's logs |

With `INDEXER_URL` (or `NEXT_PUBLIC_INDEXER_URL`) set on the server, the latest fills come from the
indexer (`source: "indexer"`), with the market's full history. Without it, or when the indexer fails, or
for an explicit `fromBlock`, they come from Kuru's `Trade` logs on the market's book, read in 100-block
windows (public Monad RPCs answer `eth_getLogs` for at most 100 blocks), and `fromBlock` and `toBlock`
say what was read.

These are the four router trades the README links (buy YES, sell YES, buy NO, sell NO on market #1),
all from our own wallet against our own maker bot:

```json
{
  "market": "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
  "id": 1,
  "count": 4,
  "source": "logs",
  "fromBlock": "67863600",
  "toBlock": "67868599",
  "note": "Fills from Kuru's logs in blocks 67863600 to 67868599.",
  "trades": [
    {
      "block": "67863658",
      "time": "2026-10-03T15:21:42.000Z",
      "tx": "0xafbee312a270e29d2218bf89890f0d8bc55658e1a9df07b4713113e30b14c72d",
      "logIndex": 5,
      "takerSide": "buy",
      "price": "0.416",
      "sizeYes": "5",
      "notionalUsdc": "2.08",
      "maker": "0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A",
      "makerIsHunchMaker": true,
      "taker": "0xB9D22C84c5e2F4329EEee1B52Ad753dF3268c2a6",
      "trader": "0xD183a7daECF3d539683f37e1111558E3dFC210A8",
      "viaRouter": true,
      "traderIsHunch": true
    },
    {
      "block": "67863641",
      "time": "2026-10-03T15:21:36.000Z",
      "tx": "0x64e40cdb81d82301412c84b15586791a59fe21dd291503877054ce0977846ced",
      "logIndex": 4,
      "takerSide": "buy",
      "price": "0.416",
      "sizeYes": "12.01923",
      "notionalUsdc": "4.999999",
      "maker": "0x0f1156Eb25DBebee5386EC80F1EB0B85C7dD232A",
      "makerIsHunchMaker": true,
      "taker": "0xB9D22C84c5e2F4329EEee1B52Ad753dF3268c2a6",
      "trader": "0xD183a7daECF3d539683f37e1111558E3dFC210A8",
      "viaRouter": true,
      "traderIsHunch": true
    }
  ]
}
```

(Trimmed to two of the four fills.) `takerSide` is `buy` when the taker bought YES from a resting ask
(a router `buyYes`, or the YES leg of a `sellNo`) and `sell` when the taker sold YES into a bid. For a
router trade, `taker` is the router and `trader` the wallet that sent the transaction. `notionalUsdc` is
size times price, rounded down, before any Kuru fee.

## GET /markets/{address}/evidence

The settlement evidence and its verification, as the SDK's `verifySettlement` computes it
([SDK.md, Verify a settlement](./SDK.md#verify-a-settlement)): the reads the resolver made, done again;
the evidence hash rebuilt from them and compared with the one the market stored; the resolver re-run as
a call. `verified` is true when the stored hash is reproduced from the source, false on any mismatch,
null when nothing could be checked. For a market that has not settled, `status` is `open` and `plan`
says what settling now would take.

```json
{
  "market": "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
  "id": 1,
  "template": { "id": 1, "name": "Perpl net funding" },
  "status": "open",
  "verified": null,
  "stored": {
    "outcome": "unresolved",
    "evidenceHash": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "recomputed": { "outcome": null, "evidenceHash": null, "evidence": null, "reads": {} },
  "matches": { "evidenceHash": null, "outcome": null, "rerun": null },
  "notes": ["Not settled yet. `plan` shows what settling now would store."],
  "settlementTx": null,
  "plan": {
    "status": "wait",
    "reason": "Waiting for block 68264006: Perpl's funding is final only after the window's last block."
  },
  "checkedAt": { "block": "68098673", "time": "2026-10-04T11:04:35.000Z" }
}
```

For a settled market, `recomputed.reads` holds what was read (Perpl's funding sums and event blocks,
the Chainlink rounds, the touching round, the spiking event, the legs, or the snapshot and the source
re-read at its block), `rerun` the resolver's answer, and `settlementTx` the transaction with its
explorer link. Anyone can repeat the check with any RPC through the SDK.

## GET /settlements

The settlement archive: every settled or voided market, newest settlement first, each with the exact
read that settled it (`reads`, `evidence`), the transaction that did it and who sent it (ours labelled),
and whether that read still reproduces today (`verified`, `matches`, the same check as
[`/markets/{address}/evidence`](#get-marketsaddressevidence)). Each record links to the app's verifier,
which re-runs the read from your browser. The app shows it at
[/settlements](https://book.playhunch.xyz/settlements).

| Query | Default | Meaning |
|---|---|---|
| `template` | all | a template id, 1 to 7 |
| `limit` | 25 | 1 to 100 |
| `offset` | 0 | |
| `format` | json | `csv` for a spreadsheet, `reads` as JSON in one column |

Markets are taken newest first, then verified (three at a time), then sorted by settlement block. The
settling transaction is found by searching `phase()` over past blocks and then reading that block's
`Settled` or `Voided` event, so the answer is never a guess: if the search cannot finish, `settledAt` and
`settlementTx` are null and `error` (or the record's absence of a transaction) says so. `complete` is
true once a record's read is checked and its transaction found; a complete record is kept for a day (a
finished market's answer never changes), an incomplete one is tried again within 30 seconds. A page of
complete records is cached for 5 minutes, any other for 30 seconds. A cold archive takes several seconds
on the public RPC. Read from Monad testnet on 2026-10-06, trimmed
to one record:

```json
{
  "network": "monad-testnet",
  "total": 4,
  "offset": 0,
  "limit": 25,
  "settlements": [
    {
      "id": 1,
      "market": "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "title": "Will MON longs pay more than $0.000015 per MON in funding on Perpl between about Oct 4, 07:40 and Oct 5, 00:55 UTC?",
      "rule": "Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block 68058301 and block 68264005?",
      "template": { "id": 1, "name": "Perpl net funding" },
      "asset": "MON",
      "status": "settled",
      "outcome": "no",
      "settledAt": { "block": "68488249", "time": "2026-10-05T19:45:55.000Z" },
      "settlementTx": {
        "hash": "0x2d53ad4c3cb322c34447839a8beea8cc3dc208c1c8fa1930fc06cab96b20fc72",
        "explorer": "https://testnet.monadscan.com/tx/0x2d53ad4c3cb322c34447839a8beea8cc3dc208c1c8fa1930fc06cab96b20fc72",
        "by": "0x1f5AC9bB0DF7d0E0DD133cBd71388e1078475569",
        "byHunch": true,
        "method": "settle"
      },
      "evidence": "0x",
      "evidenceHash": "0x87da69cba433469e3382279788685ebb0e11c8d2132b9eda5fad45c4c33a845a",
      "reads": {
        "exchange": "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
        "perpId": "64",
        "startBlock": "68058301",
        "endBlock": "68264005",
        "sumStart": "-21121",
        "sumEnd": "-20390",
        "eventStart": "68053740",
        "eventEnd": "68259444",
        "delta": "731",
        "threshold": "1500"
      },
      "verified": true,
      "matches": { "evidenceHash": true, "outcome": true, "rerun": true },
      "notes": [],
      "complete": true,
      "error": null,
      "links": {
        "app": "https://book.playhunch.xyz/m/0x2A44B99014cF73065BFb89197a08DE09D18d3982",
        "verify": "https://book.playhunch.xyz/verify/0x2A44B99014cF73065BFb89197a08DE09D18d3982",
        "evidence": "https://book.playhunch.xyz/api/v1/markets/0x2A44B99014cF73065BFb89197a08DE09D18d3982/evidence",
        "explorer": "https://testnet.monadscan.com/address/0x2A44B99014cF73065BFb89197a08DE09D18d3982"
      }
    }
  ],
  "howToCheck": "Each record's verify link re-runs the read in your browser; the SDK's verifySettlement does the same with any RPC (docs/SDK.md)."
}
```

Here the read is Perpl's funding sum at the window's two edges: it moved by 731 raw units, under the
threshold of 1,500, so NO. The keeper settled it, late (see the [incident log](./INCIDENTS.md)).

## GET /stats

From the chain: markets by phase and template, USDC in open pools, and the vault's USDC against
everything it owes (`solvent` is `surplusUsdc >= 0`, docs/PROTOCOL.md §5.1). With an indexer configured,
`activity` adds wallets, stakes, fills, volume, router trades and redemptions, each with the part that
is ours: fills against our maker bot, and the maker's share of fills and of volume.

```json
{
  "network": "monad-testnet",
  "chainId": 10143,
  "asOf": { "block": "68098721", "time": "2026-10-04T11:04:49.000Z" },
  "markets": {
    "total": 1,
    "byPhase": { "pool": 0, "pool-locked": 0, "trading": 1, "closed": 0, "settled": 0, "voided": 0 },
    "byTemplate": { "1": 1 },
    "graduatedEver": 1
  },
  "pools": { "open": 0, "stakedUsdc": "0" },
  "vault": {
    "address": "0x81b04B3567dcaDaE6a859394248C47ddc403ba37",
    "usdcHeld": "710",
    "owedUsdc": "710",
    "surplusUsdc": "0",
    "solvent": true,
    "capUsdc": "50000"
  },
  "activity": null,
  "sources": { "chain": "https://testnet.monadscan.com", "indexer": "not configured: activity totals are null" }
}
```

With the indexer, `activity` looks like:

```json
{
  "wallets": { "total": 14, "ours": 3, "others": 11 },
  "stakes": { "count": 12, "usdc": "700", "countOurs": 11, "usdcOurs": "690" },
  "fills": { "count": 10, "againstOurMaker": 9, "betweenOthers": 1, "ourMakerShare": "90%" },
  "volume": { "usdc": "50", "againstOurMakerUsdc": "45", "betweenOthersUsdc": "5", "ourMakerShare": "90%" },
  "routerTrades": { "count": 4, "usdc": "20" },
  "redemptions": { "count": 0, "usdc": "0" },
  "indexedToBlock": "68059000"
}
```

(An illustration of the shape, not live numbers: the indexer is not deployed to a hosted endpoint yet.)

## GET /feed

The markets someone can act on now (a pool taking stakes, or a book trading), ending soonest first, as
small cards. The schema is versioned (`version`); fields are only ever added.

```json
{
  "version": 1,
  "source": "Hunch Book",
  "network": "monad-testnet",
  "generatedAt": "2026-10-04T08:43:08.637Z",
  "home": "https://book.playhunch.xyz",
  "count": 1,
  "cards": [
    {
      "id": "hunch-book:monad-testnet:0x2a44b99014cf73065bfb89197a08de09d18d3982",
      "marketId": 1,
      "address": "0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "title": "Will MON longs pay more than $0.000015 per MON in funding on Perpl (MON Perp, perp 64) between block 68058301 and block 68264005?",
      "template": "Perpl net funding",
      "asset": "MON",
      "status": "trading",
      "chance": { "yes": 0.3835, "bps": 3835, "source": "book" },
      "pool": { "totalUsdc": "690", "stakers": 11 },
      "book": { "bid": "0.368", "ask": "0.399" },
      "endsAt": "2026-10-05T00:56:44.000Z",
      "endsAtEstimated": true,
      "url": "https://book.playhunch.xyz/m/0x2A44B99014cF73065BFb89197a08DE09D18d3982",
      "embedUrl": "https://book.playhunch.xyz/embed/m/0x2A44B99014cF73065BFb89197a08DE09D18d3982"
    }
  ]
}
```

| Card field | Meaning |
|---|---|
| `id` | stable across requests: `hunch-book:<network>:<market address in lowercase>` |
| `title` | the rule in one sentence, from the market's resolver |
| `status` | `pool` (staking open) or `trading` (YES and NO trade on the book) |
| `chance.yes` | chance of YES from 0 to 1, null when there is no price yet; `bps` the same in basis points; `source` as in `/markets` |
| `pool` | USDC staked and the number of stakers (for a trading market, the pool it graduated with) |
| `book` | best YES bid and ask, USDC per token, while trading; null for pools |
| `endsAt` | when staking stops (pool) or the market closes (trading); `endsAtEstimated` for block-clock markets |
| `url`, `embedUrl` | the market page, and its card for an iframe |

## GET /funding/{asset}

"What does the market think?" for one Perpl perp: the open market that asks whether that perp's longs pay
funding this period (template 1, Perpl net funding), its chance, the question in plain words, its window
and links. Made for perp traders and for Perpl's own pages; the [funding card](#funding-card) shows the
same answer in an iframe.

`asset` is a perp named in `external.perpl.perps` of the deployments file: `BTC`, `ETH`, `SOL` or `MON`,
in any case.

**Which market answers.** Among the open template 1 markets on that perp (a pool taking stakes before its
window starts, or a book trading before its window ends, checked against the chain head), the newest one
whose funding window is running now; if none is running, the newest one still to start. Newest is the
highest market number. So while this week's market trades, next week's new pool does not replace it.
`pick` carries this rule, whether it matched a `running` or an `upcoming` market, and how many were open;
`alsoOpen` lists the others.

**The chance** is the market's own, as `/markets` computes it: the Kuru book's mid once the market has
graduated, the pool's split before. `headline` puts it in one sentence, with the percent rounded to a
whole number (never to 0% or 100% unless it is exactly that). The clause comes from the resolver's own
rule: "BTC longs pay more than $12.04 per BTC", "BTC longs pay shorts on net", or, for a negative
threshold, "BTC shorts pay longs less than $5 per BTC on net". The period is "this week" for a running
window of about seven days, "in the coming week" before it starts, and the window's length otherwise.

```js
const res = await fetch("https://book.playhunch.xyz/api/v1/funding/BTC");
const view = await res.json();
if (view.market) {
  // for example "Market's chance BTC longs pay more than $12.04 per BTC this week: 62%"
  console.log(view.market.headline, view.market.links.app);
} else {
  console.log(view.reason);
}
```

A real answer, at block 68,495,713 (market #7 is a pool, so the chance is its split):

```json
{
  "network": "monad-testnet",
  "asset": "MON",
  "perp": { "id": "64", "exchange": "0x1964C32f0bE608E7D29302AFF5E61268E72080cc" },
  "pick": {
    "rule": "running-window-first-then-newest",
    "text": "Among the open template 1 (Perpl net funding) markets on this perp (a pool taking stakes before its window starts, or a book trading before its window ends), the newest one whose funding window is running now; if none is running, the newest one still to start. Newest is the highest market number.",
    "matched": "upcoming",
    "candidates": 1
  },
  "market": {
    "id": 7,
    "address": "0x6FFC70F919e9B6e20aD76df870854818C310cD9e",
    "phase": "pool",
    "phaseLabel": "Pool",
    "headline": "Market's chance MON shorts pay longs less than $0.00000031 per MON on net in the next 85-minute window: 50%",
    "clause": "MON shorts pay longs less than $0.00000031 per MON on net",
    "period": "in the next 85-minute window",
    "question": "Will MON longs pay more than -$0.00000031 per MON in funding on Perpl between about Oct 6, 14:40 and Oct 6, 16:05 UTC?",
    "rule": "Will MON longs pay more than -$0.00000031 per MON in funding on Perpl (MON Perp, perp 64) between block 68713707 and block 68730849?",
    "chance": { "yes": 0.5, "bps": 5000, "percent": "50%", "source": "pool", "words": "the pool's split" },
    "window": {
      "startBlock": "68713707",
      "endBlock": "68730849",
      "startAt": "2026-10-06T14:40:43.000Z",
      "endAt": "2026-10-06T16:07:00.000Z",
      "estimated": true,
      "running": false,
      "words": "between about Oct 6, 14:40 and Oct 6, 16:05 UTC"
    },
    "threshold": { "raw": "-31", "expectedScalingExp": 3 },
    "pool": { "totalUsdc": "480", "stakers": 8 },
    "book": null,
    "createdByHunch": true,
    "links": {
      "app": "https://book.playhunch.xyz/m/0x6FFC70F919e9B6e20aD76df870854818C310cD9e",
      "verify": "https://book.playhunch.xyz/verify/0x6FFC70F919e9B6e20aD76df870854818C310cD9e",
      "api": "https://book.playhunch.xyz/api/v1/markets/0x6FFC70F919e9B6e20aD76df870854818C310cD9e",
      "evidence": "https://book.playhunch.xyz/api/v1/markets/0x6FFC70F919e9B6e20aD76df870854818C310cD9e/evidence",
      "embed": "https://book.playhunch.xyz/embed/m/0x6FFC70F919e9B6e20aD76df870854818C310cD9e",
      "explorer": "https://testnet.monadscan.com/address/0x6FFC70F919e9B6e20aD76df870854818C310cD9e"
    }
  },
  "reason": null,
  "alsoOpen": [],
  "asOf": { "block": "68495713", "time": "2026-10-05T20:23:29.000Z" },
  "links": {
    "embed": "https://book.playhunch.xyz/embed/funding/MON",
    "calculator": "https://book.playhunch.xyz/calculator?perp=MON",
    "markets": "https://book.playhunch.xyz/api/v1/markets?template=1&asset=MON&phase=open",
    "create": "https://book.playhunch.xyz/create?template=1&asset=MON"
  }
}
```

With no open market, `market` is null and `reason` says why; the links stay, including one that opens
the create page on template 1 for that perp. The same read for BTC:

```json
{
  "network": "monad-testnet",
  "asset": "BTC",
  "perp": { "id": "16", "exchange": "0x1964C32f0bE608E7D29302AFF5E61268E72080cc" },
  "pick": { "rule": "running-window-first-then-newest", "text": "(as above)", "matched": null, "candidates": 0 },
  "market": null,
  "reason": "No template 1 (Perpl net funding) market on BTC is open right now: none is taking stakes before its window starts or trading before its window ends.",
  "alsoOpen": [],
  "asOf": { "block": "68495713", "time": "2026-10-05T20:23:29.000Z" },
  "links": {
    "embed": "https://book.playhunch.xyz/embed/funding/BTC",
    "calculator": "https://book.playhunch.xyz/calculator?perp=BTC",
    "markets": "https://book.playhunch.xyz/api/v1/markets?template=1&asset=BTC&phase=open",
    "create": "https://book.playhunch.xyz/create?template=1&asset=BTC"
  }
}
```

| Field | Meaning |
|---|---|
| `perp` | Perpl's id for the perp on this network, and Perpl's Exchange address |
| `pick` | the rule that chose the market, `matched` (`running`, `upcoming` or null) and `candidates` (open template 1 markets on the perp) |
| `market.headline` | the answer in one sentence, ending in the chance |
| `market.clause`, `market.period` | the two halves of the headline: what YES means, and when |
| `market.question` | the rule with its blocks as estimated times; `rule` is the resolver's exact sentence |
| `market.chance` | `yes` from 0 to 1, `bps`, `percent`, `source` as in `/markets`, and `words` for people |
| `market.window` | the funding window A to B as blocks, their estimated times, `running` (A is at or before the head) and `words`. B is the market's close; for a pool, staking closes at A |
| `market.threshold` | the market's raw threshold in Perpl's units, and the scaling exponent it was made with |
| `market.book` | best YES bid, ask and mid while trading; null for pools |
| `market.createdByHunch` | true when one of Hunch Book's own wallets (such as the keeper's weekly series) created it |
| `market.links` | the market page, its settlement page (`verify`), its API entries, its card, and the explorer |
| `alsoOpen` | the other open template 1 markets on the perp, newest first |
| `asOf` | the chain head the answer was computed at |

Errors: `400` for an asset that is not letters and digits, `404` for an asset the deployments file does
not list (the message names the ones it does), `502` when the chain does not answer. `?format=csv` gives
`field,value` rows. Cached like the feed: 15 seconds.

## Embed

`https://book.playhunch.xyz/embed/m/{address}` is a market card for an iframe: the rule, the phase, the
chance of YES with a YES/NO bar, the pool or the book's best prices, when it closes, and a link back to
the market page. It is one HTML page with no script and no wallet, in the main Hunch app's style, and it
refreshes itself every minute. Every value from the chain is HTML-escaped.

```html
<iframe
  src="https://book.playhunch.xyz/embed/m/0x2A44B99014cF73065BFb89197a08DE09D18d3982"
  title="Hunch Book market"
  width="420"
  height="240"
  style="border:0;border-radius:14px"
  loading="lazy"
></iframe>
```

Framing is allowed only under `/embed`: the cards answer with `Content-Security-Policy: frame-ancestors *`
(and `default-src 'none'`), while every other page of the app keeps `X-Frame-Options: DENY` and
`frame-ancestors 'none'`. An address that is not a market gets a short card saying so, with a `404`.

## Funding card

`https://book.playhunch.xyz/embed/funding/{asset}` is the [funding answer](#get-fundingasset) as a card
for an iframe, sized for a perp's page on an exchange such as Perpl: one line such as "Market's chance
BTC longs pay more than $12.04 per BTC this week", the chance in large type with a YES/NO bar, the
book's prices or the pool, the funding window, and a link to stake or trade on the market page. With no
open market it says so and links to the create page for that perp. Same approach as the market card:
one HTML page, no script, no wallet, every value HTML-escaped, refreshed every minute, cached for 30
seconds.

```html
<iframe
  src="https://book.playhunch.xyz/embed/funding/BTC"
  title="What the market thinks about BTC funding"
  width="420"
  height="300"
  style="border:0;border-radius:14px"
  loading="lazy"
></iframe>
```

An asset the deployments file does not list gets a short card naming the ones it does, with a `404`.

The [funding-cost calculator](../apps/web/src/app/calculator) at `/calculator` is the same idea for a
person: what a position pays in funding over a day, a week or any horizon, from Perpl's live funding
history, with the markets that would hedge it ([HEDGE.md](./HEDGE.md#the-calculator)). It takes its
inputs from the address: `/calculator?perp=BTC&side=long&size=0.5&unit=units&horizon=7d&rate=last`.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `NEXT_PUBLIC_HUNCH_NETWORK` | `monad-testnet` | the network the app and the API serve |
| `HUNCH_API_RPC_URL` | `MONAD_TESTNET_RPC` (or `MONAD_MAINNET_RPC`), else the deployment's public RPC | the server's RPC for API reads |
| `INDEXER_URL`, `NEXT_PUBLIC_INDEXER_URL` | none | the indexer's GraphQL endpoint, for trade history and activity totals |
| `NEXT_PUBLIC_SITE_URL` | `https://book.playhunch.xyz` | the origin used in links |

## Tests

```sh
pnpm --filter @hunch-book/web exec vitest run test/api-v1.test.ts test/funding-api.test.ts
```

The handlers are tested with a fake SDK and a fake RPC: filters, paging and CSV for markets; detail with
book levels; trades from logs in 100-block windows (with our maker and trader labelled), from the
indexer, the fallback when the indexer fails, and explicit ranges; evidence; stats with the vault's
solvency and indexed activity; the feed's cards; the embed's headers, escaping and messages; CORS,
cache headers and errors; and that only `/embed` may be framed. `funding-api.test.ts` covers the funding
answer: the picking rule (a running window over a newer pool, the newest upcoming one otherwise, other
perps, spike markets, finished windows and passed locks left out), the clause and period wording, the
rounding of the chance, the no-market answer, unknown and malformed assets, CSV, and the funding card's
text, links and escaping.
