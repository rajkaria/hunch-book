# Accounts and gas

Status: **building**. Passkey accounts work in the app on any domain that serves it. The gas drip and
relayed stakes need a relayer key on the server (`RELAYER_PRIVATE_KEY`); until the host has one, both
answer "not set up" and the app shows the MON faucet instead. Design: [PROTOCOL.md §9.5](./PROTOCOL.md).

## Two kinds of account

| Account | What it is | Who holds the key |
|---|---|---|
| Browser wallet | MetaMask, Rabby or any EIP-6963 wallet | the wallet extension |
| Passkey account | an ordinary Monad account (an EOA) derived from a passkey in your browser | nobody: it is derived again from your passkey each time you sign in |

Both are plain accounts. Every action in the app (stake, trade, claim, settle, redeem) works the same
way with either.

## How a passkey account works

The app uses [Mera](https://mera.category.xyz) (`@category-labs/mera`, version 0.2.0) by Category
Labs.

1. **Create.** The browser makes a new passkey for this website and evaluates the WebAuthn PRF
   extension with a fixed salt. That gives 32 secret bytes that only this passkey, on this website,
   can produce.
2. **Derive.** Those bytes become BIP-39 entropy, then a seed, then the key at the first Ethereum path
   `m/44'/60'/0'/0/0`. This is the derivation Mera documents, so the same passkey gives the same
   address in any app that follows it on the same website.
3. **Sign.** The key goes into a Mera signing session in the tab's memory. The session signs
   transactions and typed data with no further prompts. Intermediate bytes (the PRF output, the seed,
   the HD nodes) are zeroed as soon as the session has its copy.
4. **Sign out.** Disconnecting ends the session and zeroes the key. Reloading the page also drops it:
   the next sign-in asks for the passkey again and derives the same account.

What the browser stores (in `localStorage`, key `hunch-book:passkey-accounts`): the credential id, its
transports, the account address, the website and the last sign-in time. All of it is public. No seed
phrase, no key and no PRF output is ever stored, and nothing is sent to a server.

There is no smart account, no paymaster and no EIP-7702 delegation. On Monad an account with a
7702 delegation cannot drop below a 10 MON reserve through transfers, so user accounts stay plain.

### A passkey belongs to one website

WebAuthn binds every passkey to a relying party id, which is the website's host:

- production: `book.playhunch.xyz`
- local development: `localhost`
- every preview deployment has its own host, so it makes a **different** account from the same person

Use the production address to get the same account every time. The connect menu says which website
the page is on. Passkeys do not work on a bare IP address (`127.0.0.1`); use `localhost`.

### Browser support

The PRF extension is needed. Current Chrome and Edge and Safari 18 or later support it; support in
third-party password managers varies. Mera keeps a list at
[mera.category.xyz/authenticator-support](https://mera.category.xyz/authenticator-support/). Where the
browser reports that PRF is missing, the menu says so before anyone tries. Where it cannot tell, a
failed attempt explains it in plain words and nothing is created.

### Recovery

The account is the passkey. If your passkey syncs (iCloud Keychain, Google Password Manager, a password
manager), signing in on another device on the same website gives the same account. If the passkey is
deleted and was not synced, the account cannot be recovered. Keep only small amounts in a passkey
account, or move funds to a wallet you back up.

## Gas for new accounts

Monad charges for a transaction's gas limit, and a new account holds no MON. Two capped paths:

### 1. The gas drip (`POST /api/drip`)

Sends `DRIP_AMOUNT_MON` (default 0.05 MON) to a new account, once. A passkey account asks for it by
itself after sign-in when it holds less than 0.01 MON; any account can ask from the account menu.

The drip goes only to an address that:

- holds less than `DRIP_BELOW_MON` (default 0.01 MON), read from the chain;
- has never sent a transaction (nonce 0), read from the chain;
- is not a contract, and is not the relayer;
- has not had a drip before (a once-per-address claim in the store);
- is within the per-IP cap (`DRIP_IP_DAILY_CAP`, default 3 a day) and the global cap
  (`DRIP_DAILY_CAP`, default 200 a day).

The first two checks come from the chain itself, so they hold across server restarts and instances:
an account that got a drip holds MON, and it cannot fall below the threshold again without sending a
transaction, which makes its nonce non-zero. The drip runs on testnet only unless `DRIP_MAINNET=1`.

### 2. Relayed stakes (`POST /api/relay/stake`)

A stake that needs no MON and no approval. The person signs one EIP-3009 `ReceiveWithAuthorization`
for USDC:

| Field | Value |
|---|---|
| domain | read from the USDC token (`eip712Domain()` or `name()`/`version()`), and checked against its `DOMAIN_SEPARATOR()` before anyone signs |
| `from` | the person's account |
| `to` | the market |
| `value` | the stake |
| `validAfter`, `validBefore` | a minute ago, ten minutes from now (the relayer refuses more than `RELAY_MAX_VALIDITY_SECONDS`, default one hour) |
| `nonce` | `keccak256(abi.encode(chainId, market, user, side, salt))`, exactly `Market.authorizationNonce` |

The relayer then calls `Market.stakeWithAuthorization(user, side, amount, validAfter, validBefore,
salt, signature)` and pays the gas. Before it spends any gas it checks:

1. the body is well formed, the network is allowed, the time window is valid;
2. the amount is at most `RELAY_MAX_STAKE_USDC` (default 1,000 USDC, the beta wallet cap);
3. the per-IP, per-account and daily caps (`RELAY_IP_DAILY_CAP` 20, `RELAY_USER_DAILY_CAP` 10,
   `RELAY_DAILY_CAP` 500);
4. the factory created the market (`isMarket`), it is in its pool phase, and the amount is at least
   its minimum stake;
5. the nonce the person signed equals the market's own `authorizationNonce(user, side, salt)`;
6. the signature recovers to the person's address;
7. the authorisation is unused (`authorizationState`) and the account holds the USDC;
8. a simulation of the call succeeds.

Then it sends the call with a gas limit of the estimate plus 10%, and returns the transaction hash,
which the app shows with its explorer link.

## What the relayer can and cannot do

| It can | It cannot |
|---|---|
| send MON from its own key (the drip) | touch any account's MON or USDC beyond what the account signed |
| submit a stake the account signed, paying the gas | change the market, the side, the amount or the recipient: the signature and the market's nonce rule bind all four |
| refuse a request (caps, checks, a failed simulation) | stake for an account that did not sign, or reuse a signature (EIP-3009 nonces are single-use) |
| | set an outcome, move vault funds, or do anything the guardian cannot |

The worst a compromised relayer key can do is spend its own MON, or delay relayed stakes by not
sending them (the signed authorisation expires within the hour, and the person can always stake
directly with a little MON).

## Settings

All are read on the server. Only the variable names appear in code and logs; the key is never printed.

| Variable | Default | Meaning |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | none | The relayer's key. Without it both routes answer 503 and the app shows the faucet. |
| `RELAYER_RPC_URL` | network default | RPC for the app's own network. Otherwise `MONAD_TESTNET_RPC` / `MONAD_MAINNET_RPC`, then `deployments/<network>.json`. |
| `DRIP_AMOUNT_MON` | `0.05` | MON per drip. |
| `DRIP_BELOW_MON` | `0.01` | Only accounts holding less than this get a drip. |
| `DRIP_IP_DAILY_CAP` | `3` | Drips per IP address per UTC day. |
| `DRIP_DAILY_CAP` | `200` | Drips per UTC day in all. |
| `DRIP_MAINNET` | off | `1` allows drips on mainnet. |
| `RELAY_MAX_STAKE_USDC` | `1000` | Largest relayed stake. |
| `RELAY_IP_DAILY_CAP` | `20` | Relayed stakes per IP address per UTC day. |
| `RELAY_USER_DAILY_CAP` | `10` | Relayed stakes per account per UTC day. |
| `RELAY_DAILY_CAP` | `500` | Relayed stakes per UTC day in all. |
| `RELAY_MAX_VALIDITY_SECONDS` | `3600` | Longest an authorisation may stay valid. |
| `RELAY_MAINNET` | off | `1` allows relayed stakes on mainnet. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | none | An Upstash Redis or Vercel KV REST endpoint for caps and the once-per-address claim. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` work too. |

`GET /api/drip` and `GET /api/relay/stake` report whether each service runs and its terms, without
any secret.

## Limits

- Without a KV store, caps and the once-per-address claim live in each server instance's memory, so
  a restart or a second instance resets them. The drip's chain checks (balance and nonce) still hold,
  so one account cannot drain the drip; the per-IP and daily caps are then per instance.
- The per-IP cap trusts `x-forwarded-for`, which Vercel sets. Behind another proxy, configure it to set
  that header.
- An account that already sent a transaction does not get a drip, even if it is empty: use the faucet.
- Relayed stakes cover staking only. Trading on the book, claiming and redeeming need a little MON,
  which the drip provides.

## Code and tests

| Path | What |
|---|---|
| `apps/web/src/lib/account/` | derivation, ceremonies, the session, what the browser remembers, the wagmi connector |
| `apps/web/src/lib/relayer/` | typed data, request parsing, settings, caps, both handlers, the live clients |
| `apps/web/src/app/api/drip/`, `apps/web/src/app/api/relay/stake/` | the route handlers |
| `apps/web/src/components/account/` | the connect-menu section, gas help, the stake-without-MON box |

`pnpm --filter @hunch-book/web test` runs the unit tests: derivation against viem's own HD path, the
connector through wagmi's actions, typed data against the token's own hashing, every refusal in both
handlers, and the stores. `HUNCH_LIVE_TESTS=1` adds read-only checks against Monad testnet with
`eth_call`: the market's `authorizationNonce` equals ours, and the test USDC accepts a signature the
app builds.
