# Security

Hunch Book holds user funds (USDC) in smart contracts. It is live on Monad testnet (test USDC) and
planned for mainnet. This page states the rules the contracts are built to and how to report a problem.
The internal review is in [docs/SECURITY-REVIEW.md](./docs/SECURITY-REVIEW.md), the audit scope in
[docs/AUDIT.md](./docs/AUDIT.md) and the bug bounty plan in [docs/BUG-BOUNTY.md](./docs/BUG-BOUNTY.md).

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this
repository (Security tab), not in a public issue. We aim to acknowledge within 24 hours. A bug
bounty with a published scope opens with the mainnet beta ([docs/BUG-BOUNTY.md](./docs/BUG-BOUNTY.md)).

## Trust model

| Question | Answer |
|---|---|
| Who holds the money? | The `CollateralVault` contract. Every YES/NO pair in existence is backed by exactly 1 USDC. |
| Who decides outcomes? | Nobody. A resolver contract reads the source (Perpl, Chainlink or Pyth) and anyone can trigger settlement. |
| What can the team do? | A guardian address can pause new markets and graduations. It cannot pause settlement or redemption, move funds or set outcomes. |
| Can contracts be upgraded? | Market, vault, token and resolver contracts are not upgradeable. A fix ships as a new factory; existing markets finish under the code they started with. |
| What if a source fails? | Each market has a settlement deadline. If the source cannot be read by then, the market voids: pool stakes are refunded in full; after graduation each YES and NO token redeems for 0.50 USDC. |
| What if Kuru stops working? | Trading on the book stops, but minting, merging, settlement and redemption never depend on Kuru. |

## Invariants the test suite enforces

1. Solvency: for every market, USDC held ≥ complete sets outstanding + fees owed.
2. Before settlement, YES supply = NO supply = complete sets outstanding.
3. The sum of all pool claims never exceeds the pool; rounding dust goes to a fee account and is
   counted.
4. After settlement, total redeemable value ≤ USDC held for that market.
5. No function lets any address set an outcome directly.
