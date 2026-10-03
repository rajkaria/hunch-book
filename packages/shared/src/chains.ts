import { defineChain } from "viem";
import { monad as viemMonad, monadTestnet as viemMonadTestnet } from "viem/chains";
import { deployments } from "./deployments.js";

// viem's built-in definitions, with the explorer taken from deployments/<network>.json.

export const monadTestnet = defineChain({
  ...viemMonadTestnet,
  blockExplorers: {
    default: { name: "MonadScan Testnet", url: deployments["monad-testnet"].explorer },
  },
});

export const monadMainnet = defineChain({
  ...viemMonad,
  blockExplorers: {
    default: { name: "MonadScan", url: deployments["monad-mainnet"].explorer },
  },
});

export const chainsByNetwork = {
  "monad-testnet": monadTestnet,
  "monad-mainnet": monadMainnet,
} as const;
