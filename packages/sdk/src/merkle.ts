import { type Address, concat, encodeAbiParameters, getAddress, type Hex, keccak256 } from "viem";

// Merkle trees for MerkleDistributor epochs (docs/PERIPHERY.md): the leaf is
//   keccak256(bytes.concat(keccak256(abi.encode(uint256 epoch, address account, uint256 amount))))
// and the tree is OpenZeppelin's StandardMerkleTree layout (leaves sorted by hash, stored in reverse at
// the end of one array, pairs hashed in sorted order), so roots and proofs equal what
// @openzeppelin/merkle-tree builds for values ["uint256", "address", "uint256"].

export interface RewardClaim {
  account: Address;
  amount: bigint;
}

export interface RewardProof extends RewardClaim {
  leaf: Hex;
  proof: Hex[];
}

export interface RewardTree {
  epoch: bigint;
  root: Hex;
  total: bigint;
  /** In the order the claims were given. */
  claims: RewardProof[];
  /** Every node, root first (OpenZeppelin's layout). */
  tree: Hex[];
}

/** MerkleDistributor.leaf(epoch, account, amount). */
export function rewardLeaf(epoch: bigint, account: Address, amount: bigint): Hex {
  return keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
        [epoch, account, amount],
      ),
    ),
  );
}

const compare = (a: Hex, b: Hex): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Hashes a pair in sorted order, as OpenZeppelin's MerkleProof and solady's MerkleProofLib do. */
export function hashPair(a: Hex, b: Hex): Hex {
  return compare(a, b) <= 0 ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * Builds the epoch's tree. Each account must appear once (merge amounts first) with an amount above
 * zero, and `epoch` must be the id the distributor's `nextEpoch()` returns when the epoch is created.
 */
export function buildRewardTree(epoch: bigint, claims: readonly RewardClaim[]): RewardTree {
  if (claims.length === 0) throw new Error("A reward tree needs at least one claim.");
  const seen = new Set<string>();
  let total = 0n;
  const hashed = claims.map((c, index) => {
    const account = getAddress(c.account);
    if (seen.has(account)) throw new Error(`${account} appears twice: merge its amounts first.`);
    seen.add(account);
    if (c.amount <= 0n) throw new Error(`${account} has an amount of ${c.amount}: leave it out.`);
    total += c.amount;
    return { index, account, amount: c.amount, leaf: rewardLeaf(epoch, account, c.amount) };
  });
  const sorted = [...hashed].sort((a, b) => compare(a.leaf, b.leaf));
  const n = sorted.length;
  const tree = new Array<Hex>(2 * n - 1);
  sorted.forEach((h, i) => {
    tree[tree.length - 1 - i] = h.leaf;
  });
  for (let i = tree.length - 1 - n; i >= 0; i--) {
    tree[i] = hashPair(tree[2 * i + 1] as Hex, tree[2 * i + 2] as Hex);
  }
  const treeIndex = new Map<number, number>();
  sorted.forEach((h, i) => {
    treeIndex.set(h.index, tree.length - 1 - i);
  });
  const proofOf = (index: number): Hex[] => {
    const proof: Hex[] = [];
    let i = index;
    while (i > 0) {
      const sibling = i % 2 === 1 ? i + 1 : i - 1;
      proof.push(tree[sibling] as Hex);
      i = Math.floor((i - 1) / 2);
    }
    return proof;
  };
  return {
    epoch,
    root: tree[0] as Hex,
    total,
    claims: hashed.map((h) => ({
      account: h.account,
      amount: h.amount,
      leaf: h.leaf,
      proof: proofOf(treeIndex.get(h.index) as number),
    })),
    tree,
  };
}

/** True if `proof` takes `leaf` to `root`, as the distributor checks it. */
export function verifyRewardProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let computed = leaf;
  for (const p of proof) computed = hashPair(computed, p);
  return computed.toLowerCase() === root.toLowerCase();
}

/** Adds up amounts per account (case-insensitive) and drops zero amounts, ready for `buildRewardTree`. */
export function mergeClaims(claims: readonly RewardClaim[]): RewardClaim[] {
  const totals = new Map<Address, bigint>();
  for (const c of claims) {
    const a = getAddress(c.account);
    totals.set(a, (totals.get(a) ?? 0n) + c.amount);
  }
  return [...totals.entries()]
    .filter(([, amount]) => amount > 0n)
    .map(([account, amount]) => ({ account, amount }));
}
