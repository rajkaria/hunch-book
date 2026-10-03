// The one Kuru OrderBook view the app needs today. Kuru's full ABI is not vendored; this matches
// `function bestBidAsk() external view returns (uint256, uint256)` on Kuru's OrderBook (PROTOCOL.md §8.1).
export const kuruOrderBookAbi = [
  {
    type: "function",
    name: "bestBidAsk",
    inputs: [],
    outputs: [
      { name: "bestBid", type: "uint256", internalType: "uint256" },
      { name: "bestAsk", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;
