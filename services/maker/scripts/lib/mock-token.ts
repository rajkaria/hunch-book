// Generated from MockToken.sol (solc 0.8.30, optimizer 200 runs). Test-only token; see MockToken.sol.

export const mockTokenAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "name_",
        type: "string",
        internalType: "string",
      },
      {
        name: "symbol_",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      {
        name: "spender",
        type: "address",
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "burn",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "spender",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const;

export const mockTokenBytecode =
  "0x608060405234801561000f575f5ffd5b5060405161093d38038061093d83398101604081905261002e916100eb565b5f61003983826101d4565b50600161004682826101d4565b50505061028e565b634e487b7160e01b5f52604160045260245ffd5b5f82601f830112610071575f5ffd5b81516001600160401b0381111561008a5761008a61004e565b604051601f8201601f19908116603f011681016001600160401b03811182821017156100b8576100b861004e565b6040528181528382016020018510156100cf575f5ffd5b8160208501602083015e5f918101602001919091529392505050565b5f5f604083850312156100fc575f5ffd5b82516001600160401b03811115610111575f5ffd5b61011d85828601610062565b602085015190935090506001600160401b0381111561013a575f5ffd5b61014685828601610062565b9150509250929050565b600181811c9082168061016457607f821691505b60208210810361018257634e487b7160e01b5f52602260045260245ffd5b50919050565b601f8211156101cf57805f5260205f20601f840160051c810160208510156101ad5750805b601f840160051c820191505b818110156101cc575f81556001016101b9565b50505b505050565b81516001600160401b038111156101ed576101ed61004e565b610201816101fb8454610150565b84610188565b6020601f821160018114610233575f831561021c5750848201515b5f19600385901b1c1916600184901b1784556101cc565b5f84815260208120601f198516915b828110156102625787850151825560209485019460019092019101610242565b508482101561027f57868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b6106a28061029b5f395ff3fe608060405234801561000f575f5ffd5b50600436106100a6575f3560e01c806340c10f191161006e57806340c10f191461012f57806370a082311461014457806395d89b41146101635780639dc29fac1461016b578063a9059cbb1461017e578063dd62ed3e14610191575f5ffd5b806306fdde03146100aa578063095ea7b3146100c857806318160ddd146100eb57806323b872dd14610102578063313ce56714610115575b5f5ffd5b6100b26101bb565b6040516100bf91906104f7565b60405180910390f35b6100db6100d6366004610547565b610246565b60405190151581526020016100bf565b6100f460025481565b6040519081526020016100bf565b6100db61011036600461056f565b6102b2565b61011d600681565b60405160ff90911681526020016100bf565b61014261013d366004610547565b610321565b005b6100f46101523660046105a9565b60036020525f908152604090205481565b6100b26103a8565b610142610179366004610547565b6103b5565b6100db61018c366004610547565b610436565b6100f461019f3660046105c9565b600460209081525f928352604080842090915290825290205481565b5f80546101c7906105fa565b80601f01602080910402602001604051908101604052809291908181526020018280546101f3906105fa565b801561023e5780601f106102155761010080835404028352916020019161023e565b820191905f5260205f20905b81548152906001019060200180831161022157829003601f168201915b505050505081565b335f8181526004602090815260408083206001600160a01b038716808552925280832085905551919290917f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925906102a09086815260200190565b60405180910390a35060015b92915050565b6001600160a01b0383165f9081526004602090815260408083203384529091528120545f19811461030b576102e78382610646565b6001600160a01b0386165f9081526004602090815260408083203384529091529020555b61031685858561044b565b506001949350505050565b8060025f8282546103329190610659565b90915550506001600160a01b0382165f908152600360205260408120805483929061035e908490610659565b90915550506040518181526001600160a01b038316905f907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef906020015b60405180910390a35050565b600180546101c7906105fa565b6001600160a01b0382165f90815260036020526040812080548392906103dc908490610646565b925050819055508060025f8282546103f49190610646565b90915550506040518181525f906001600160a01b038416907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200161039c565b5f61044233848461044b565b50600192915050565b6001600160a01b0383165f9081526003602052604081208054839290610472908490610646565b90915550506001600160a01b0382165f908152600360205260408120805483929061049e908490610659565b92505081905550816001600160a01b0316836001600160a01b03167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef836040516104ea91815260200190565b60405180910390a3505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b0381168114610542575f5ffd5b919050565b5f5f60408385031215610558575f5ffd5b6105618361052c565b946020939093013593505050565b5f5f5f60608486031215610581575f5ffd5b61058a8461052c565b92506105986020850161052c565b929592945050506040919091013590565b5f602082840312156105b9575f5ffd5b6105c28261052c565b9392505050565b5f5f604083850312156105da575f5ffd5b6105e38361052c565b91506105f16020840161052c565b90509250929050565b600181811c9082168061060e57607f821691505b60208210810361062c57634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52601160045260245ffd5b818103818111156102ac576102ac610632565b808201808211156102ac576102ac61063256fea2646970667358221220d9ad6f2cbd71c18041f09db2ee01734bfad51feef4b23e1ee9b675504deacd2b64736f6c634300081e0033" as const;
