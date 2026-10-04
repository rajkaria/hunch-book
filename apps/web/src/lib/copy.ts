// Product copy used in more than one place, and what each page will show once the contracts are
// deployed (shown in not-deployed states). Plain words, short sentences.

/** The one-sentence description: page metadata, the footer and the share card. */
export const DESCRIPTION =
  "Prediction markets on Monad that start as USDC pools, graduate to Kuru's onchain order book, and settle by reading the chain.";

/** The three stages, as the landing headline and the share card say them. */
export const TAGLINE = ["Start as a pool.", "Graduate to a book.", "Settle from the chain."] as const;

/** Where each part comes from. */
export const BUILT_ON = "Built on Monad, trades on Kuru, settles from Perpl and Chainlink.";

/** Said wherever testnet money could be mistaken for real money. */
export const TESTNET_MONEY = "Testnet: stakes use Hunch Book's own test USDC, not real money.";

export const MARKETS_WILL_SHOW = [
  "Every market from the factory, newest first, with its rule in one sentence.",
  "Its phase: pool filling, trading on Kuru, settling or settled.",
  "The implied chance of YES, the pool size and the time left to lock or close.",
];

export const MARKET_WILL_SHOW = [
  "The rule in one sentence, read from the market's resolver contract.",
  "The implied chance, the pool on each side and the number of stakers.",
  "The timeline (lock, close, settlement deadline), the data source and the void terms.",
  "A ticket to stake USDC on YES or NO, with the payout worked out by the same math as the contract.",
];

export const PORTFOLIO_WILL_SHOW = [
  "What your wallet staked on each side of every market.",
  "YES and NO tokens you can claim after a market graduates.",
  "Pool payouts you can claim after a pool-only market settles.",
];

export const VERIFY_WILL_SHOW = [
  "The outcome and the evidence hash the market stored when it settled.",
  "The resolver contract and the exact parameters it read.",
];
