import { type Address, encodeAbiParameters, type Hex, keccak256 } from "viem";

// The evidence hash each resolver stores for templates 3, 4 and 6, rebuilt in TypeScript (templates 1
// and 2 are in the shared package: perplEvidenceHash and chainlinkEvidenceHash; template 5 uses
// template 2's). Each one is the keccak256 of exactly what the resolver read (docs/TEMPLATES.md).

/** Template 3 YES: keccak256(abi.encode(address feed, uint80 roundId, uint256 updatedAt, int256 answer)). */
export function touchYesHash(a: { feed: Address; roundId: bigint; updatedAt: bigint; answer: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint80" }, { type: "uint256" }, { type: "int256" }],
      [a.feed, a.roundId, a.updatedAt, a.answer],
    ),
  );
}

/**
 * Template 3 NO: keccak256(abi.encode(address feed, uint64 endTime, uint256 challengeEnd,
 * uint80 latestRoundId, uint256 latestUpdatedAt)), the latest round when NO was settled.
 */
export function touchNoHash(a: {
  feed: Address;
  endTime: bigint;
  challengeEnd: bigint;
  latestRoundId: bigint;
  latestUpdatedAt: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint64" }, { type: "uint256" }, { type: "uint80" }, { type: "uint256" }],
      [a.feed, a.endTime, a.challengeEnd, a.latestRoundId, a.latestUpdatedAt],
    ),
  );
}

/**
 * Template 4 YES: keccak256(abi.encode(address exchange, uint256 perpId, uint64 e, int48 F(e),
 * uint256 previousEventBlock, int48 F(previous))).
 */
export function spikeYesHash(a: {
  exchange: Address;
  perpId: bigint;
  eventBlock: bigint;
  sum: bigint;
  previousEventBlock: bigint;
  previousSum: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "int48" },
        { type: "uint256" },
        { type: "int48" },
      ],
      [a.exchange, a.perpId, a.eventBlock, Number(a.sum), a.previousEventBlock, Number(a.previousSum)],
    ),
  );
}

/**
 * Template 4 NO: keccak256(abi.encode(address exchange, uint256 perpId, uint64 endBlock,
 * uint256 challengeEndBlock, uint256 lastEventBlock, int48 F(lastEvent))).
 */
export function spikeNoHash(a: {
  exchange: Address;
  perpId: bigint;
  endBlock: bigint;
  challengeEndBlock: bigint;
  lastEventBlock: bigint;
  lastSum: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "int48" },
      ],
      [a.exchange, a.perpId, a.endBlock, a.challengeEndBlock, a.lastEventBlock, Number(a.lastSum)],
    ),
  );
}

/** Template 6: keccak256(abi.encode(address[] legs, uint8[] outcomes, bytes32[] legEvidenceHashes)). */
export function parlayHash(a: {
  legs: readonly Address[];
  outcomes: readonly number[];
  hashes: readonly Hex[];
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint8[]" }, { type: "bytes32[]" }],
      [a.legs, a.outcomes, a.hashes],
    ),
  );
}

/**
 * Templates 2 and 5 from a Pyth update: keccak256(abi.encode(uint8 1, address pyth, bytes32 id,
 * (int64 price, uint64 conf, int32 expo, uint256 publishTime), uint64 T)).
 */
export function pythEvidenceHash(a: {
  pyth: Address;
  id: Hex;
  price: { price: bigint; conf: bigint; expo: number; publishTime: bigint };
  target: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "address" },
        { type: "bytes32" },
        {
          type: "tuple",
          components: [
            { name: "price", type: "int64" },
            { name: "conf", type: "uint64" },
            { name: "expo", type: "int32" },
            { name: "publishTime", type: "uint256" },
          ],
        },
        { type: "uint64" },
      ],
      [1, a.pyth, a.id, a.price, a.target],
    ),
  );
}
