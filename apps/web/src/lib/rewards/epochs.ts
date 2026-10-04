import {
  type Address,
  concat,
  encodeAbiParameters,
  getAddress,
  type Hex,
  isAddress,
  isAddressEqual,
  keccak256,
} from "viem";

// Reward epochs for the MerkleDistributor (docs/PERIPHERY.md, MerkleDistributor): maker rewards and
// referral shares, published as one JSON file per epoch. The file is only a delivery format: every claim is
// checked here against the root with the same leaf and pair hashing as the contract, and the contract
// checks it again. A file that does not match its own root, or the root onchain, is shown and not claimed.
//
// File format (amounts as decimal strings in the token's base units):
//   { "epoch": "1", "token": "0x…", "total": "1000000", "root": "0x…",
//     "claimDeadline": 1790000000,            // optional, unix seconds; the contract's value wins
//     "kind": "maker" | "referral" | "mixed",  // optional
//     "claims": [ { "account": "0x…", "amount": "250000", "proof": ["0x…", …] }, … ] }

export interface EpochClaim {
  account: Address;
  amount: bigint;
  proof: Hex[];
}

export type EpochKind = "maker" | "referral" | "mixed";

export interface EpochFile {
  epoch: bigint;
  token: Address;
  total: bigint;
  root: Hex;
  claimDeadline: number | null;
  kind: EpochKind | null;
  claims: EpochClaim[];
  /** Where the file came from (a file name or URL), for messages. */
  source: string;
}

export class EpochFileError extends Error {}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function bigintField(value: unknown, field: string, source: string): bigint {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new EpochFileError(`${source}: "${field}" must be a whole number, written as a string.`);
}

function addressField(value: unknown, field: string, source: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new EpochFileError(`${source}: "${field}" must be an address.`);
  }
  return getAddress(value);
}

function hashField(value: unknown, field: string, source: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) {
    throw new EpochFileError(`${source}: "${field}" must be a 32-byte hex value.`);
  }
  return value.toLowerCase() as Hex;
}

/** Parses and checks one epoch file. Throws EpochFileError with a plain sentence when it is malformed. */
export function parseEpochFile(json: unknown, source: string): EpochFile {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new EpochFileError(`${source}: an epoch file is a JSON object.`);
  }
  const o = json as Record<string, unknown>;
  const epoch = bigintField(o.epoch, "epoch", source);
  const token = addressField(o.token, "token", source);
  const total = bigintField(o.total, "total", source);
  const root = hashField(o.root, "root", source);
  if (!Array.isArray(o.claims)) throw new EpochFileError(`${source}: "claims" must be a list.`);
  const seen = new Set<string>();
  let sum = 0n;
  const claims = o.claims.map((c, i): EpochClaim => {
    const where = `claims[${i}]`;
    if (typeof c !== "object" || c === null)
      throw new EpochFileError(`${source}: ${where} must be an object.`);
    const r = c as Record<string, unknown>;
    const account = addressField(r.account, `${where}.account`, source);
    const amount = bigintField(r.amount, `${where}.amount`, source);
    if (!Array.isArray(r.proof)) throw new EpochFileError(`${source}: ${where}.proof must be a list.`);
    const proof = r.proof.map((p, j) => hashField(p, `${where}.proof[${j}]`, source));
    const key = account.toLowerCase();
    if (seen.has(key)) throw new EpochFileError(`${source}: ${account} appears twice. Merge its amounts.`);
    seen.add(key);
    sum += amount;
    return { account, amount, proof };
  });
  if (sum > total) throw new EpochFileError(`${source}: the claims add up to more than the total.`);
  const deadline = o.claimDeadline;
  const kind = o.kind;
  return {
    epoch,
    token,
    total,
    root,
    claimDeadline: typeof deadline === "number" && Number.isSafeInteger(deadline) ? deadline : null,
    kind: kind === "maker" || kind === "referral" || kind === "mixed" ? kind : null,
    claims,
    source,
  };
}

/** Parses a JSON value that holds one epoch file or a list of them. Bad entries become errors, not throws. */
export function parseEpochFiles(json: unknown, source: string): { files: EpochFile[]; errors: string[] } {
  const list = Array.isArray(json) ? json : [json];
  const files: EpochFile[] = [];
  const errors: string[] = [];
  list.forEach((entry, i) => {
    try {
      files.push(parseEpochFile(entry, list.length > 1 ? `${source} #${i + 1}` : source));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `${source}: could not read it.`);
    }
  });
  return { files, errors };
}

/** MerkleDistributor.leaf: keccak256(bytes.concat(keccak256(abi.encode(epoch, account, amount)))). */
export function leafHash(epoch: bigint, account: Address, amount: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [epoch, account, amount],
    ),
  );
  return keccak256(inner);
}

/** Hashes a pair in sorted order, as OpenZeppelin's MerkleProof does. */
export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** The root a proof leads to from a leaf. */
export function processProof(leaf: Hex, proof: readonly Hex[]): Hex {
  return proof.reduce<Hex>((node, sibling) => hashPair(node, sibling), leaf);
}

export function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  return processProof(leaf, proof).toLowerCase() === root.toLowerCase();
}

/** The account's claim in this file, or null. */
export function claimOf(file: EpochFile, account: Address): EpochClaim | null {
  return file.claims.find((c) => isAddressEqual(c.account, account)) ?? null;
}

/** True when the claim's proof leads to the file's root. */
export function claimVerifies(file: EpochFile, claim: EpochClaim): boolean {
  return verifyProof(leafHash(file.epoch, claim.account, claim.amount), claim.proof, file.root);
}

/** A sorted-pair tree over leaves, for tests and tooling: returns the root and each leaf's proof. */
export function buildTree(leaves: readonly Hex[]): { root: Hex; proofs: Hex[][] } {
  if (leaves.length === 0) throw new Error("a tree needs at least one leaf");
  let level: Hex[] = [...leaves];
  const proofs: Hex[][] = leaves.map(() => []);
  let positions = leaves.map((_, i) => i);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Hex;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    positions = positions.map((pos, leaf) => {
      const sibling = pos % 2 === 0 ? pos + 1 : pos - 1;
      const node = level[sibling];
      if (node !== undefined) proofs[leaf]?.push(node);
      return Math.floor(pos / 2);
    });
    level = next;
  }
  return { root: level[0] as Hex, proofs };
}
