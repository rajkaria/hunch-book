// @hunch-book/sdk: read Hunch Book markets, quote trades on their Kuru books, send every lifecycle
// action, find settlement evidence for templates 1 to 6, verify settlements, use the periphery, and
// build reward trees. Every function takes a context first (tree-shakeable); createHunchClient binds
// them all to one. docs/SDK.md has the guide.

export {
  addressUrl,
  type BracketResult,
  type ChainlinkTouchParams,
  type Deployment,
  deployments,
  EMPTY_EVIDENCE,
  type L2Level,
  loadDeployment,
  monadMainnet,
  monadTestnet,
  type Network,
  ONE_USDC,
  Outcome,
  type ParlayParams,
  type PerplFundingParams,
  type PerplFundingSpikeParams,
  Phase,
  type PriceAtTimeParams,
  type PriceRangeParams,
  PriceSource,
  Side,
  TEMPLATES,
  TemplateId,
  TouchDirection,
  type TradeKind,
  txUrl,
} from "@hunch-book/shared";
export * from "./actions.js";
export * from "./book.js";
export * from "./client.js";
export {
  accountAddress,
  type ContextOptions,
  createContext,
  MULTICALL3,
  type PythOptions,
  requireWallet,
  type SigningWallet,
} from "./context.js";
export * from "./errors.js";
export * from "./markets.js";
export * from "./merkle.js";
export * from "./params.js";
export * from "./periphery.js";
export * from "./quotes.js";
export * from "./settlement/chainlink.js";
export * from "./settlement/evidence.js";
export * from "./settlement/hashes.js";
export * from "./settlement/perpl.js";
export * from "./settlement/pyth.js";
export * from "./settlement/verify.js";
export * from "./tx.js";
export * from "./units.js";
