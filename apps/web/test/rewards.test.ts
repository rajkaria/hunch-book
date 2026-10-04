import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildTree,
  claimOf,
  claimVerifies,
  type EpochClaim,
  type EpochFile,
  EpochFileError,
  hashPair,
  leafHash,
  parseEpochFile,
  parseEpochFiles,
  verifyProof,
} from "../src/lib/rewards/epochs";
import { loadPublishedEpochs, serializeEpoch } from "../src/lib/rewards/load";
import { claimStatus, type OnchainEpoch } from "../src/lib/rewards/status";
import { USER } from "./fixtures";

const TOKEN = getAddress("0x00000000000000000000000000000000000000ab");
const ALICE = getAddress(USER);
const BOB = getAddress("0x00000000000000000000000000000000000000b1");
const CAROL = getAddress("0x00000000000000000000000000000000000000b2");
const NOW = 1_799_000_000;

/** An epoch file with a real tree over its claims, as the rewards service would publish it. */
function makeEpoch(epoch: bigint, claims: { account: Address; amount: bigint }[]): EpochFile {
  const leaves = claims.map((c) => leafHash(epoch, c.account, c.amount));
  const tree = buildTree(leaves);
  return {
    epoch,
    token: TOKEN,
    total: claims.reduce((s, c) => s + c.amount, 0n),
    root: tree.root,
    claimDeadline: null,
    kind: "maker",
    claims: claims.map((c, i) => ({ ...c, proof: tree.proofs[i] ?? [] })),
    source: "test",
  };
}

const onchainFor = (f: EpochFile, over: Partial<OnchainEpoch> = {}): OnchainEpoch => ({
  token: f.token,
  claimDeadline: BigInt(NOW + 7 * 86_400),
  swept: false,
  root: f.root,
  total: f.total,
  claimed: 0n,
  ...over,
});

describe("Merkle leaves and proofs", () => {
  it("hashes a leaf exactly as MerkleDistributor.leaf does (vector computed with cast)", () => {
    // cast keccak $(cast keccak $(cast abi-encode "f(uint256,address,uint256)" 7 0x...b0 250000))
    expect(leafHash(7n, ALICE, 250_000n)).toBe(
      "0x947cfff8ecd7f087c99a38592f6ee6835ee42339c30e57c2406f41d4129942de",
    );
  });

  it("hashes pairs in sorted order, so a proof works from either side", () => {
    const a = leafHash(1n, ALICE, 1n);
    const b = leafHash(1n, BOB, 2n);
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });

  it("verifies every claim of a tree, and nothing else", () => {
    const file = makeEpoch(3n, [
      { account: ALICE, amount: 100n },
      { account: BOB, amount: 200n },
      { account: CAROL, amount: 300n },
    ]);
    for (const c of file.claims) expect(claimVerifies(file, c)).toBe(true);
    const alice = claimOf(file, ALICE);
    expect(alice).not.toBeNull();
    expect(claimVerifies(file, { ...(alice as EpochClaim), amount: 101n })).toBe(false);
    expect(verifyProof(leafHash(4n, ALICE, 100n), alice?.proof ?? [], file.root)).toBe(false);
    expect(claimOf(file, getAddress("0x00000000000000000000000000000000000000ff"))).toBeNull();
  });

  it("treats a single-leaf tree's leaf as its root", () => {
    const file = makeEpoch(1n, [{ account: ALICE, amount: 5n }]);
    expect(file.root).toBe(leafHash(1n, ALICE, 5n));
    expect(claimVerifies(file, file.claims[0] as never)).toBe(true);
  });
});

describe("epoch files", () => {
  const raw = {
    epoch: "2",
    token: TOKEN.toLowerCase(),
    total: "300",
    root: `0x${"11".repeat(32)}`,
    claimDeadline: NOW,
    kind: "referral",
    claims: [
      { account: ALICE.toLowerCase(), amount: "100", proof: [`0x${"22".repeat(32)}`] },
      { account: BOB, amount: 200, proof: [] },
    ],
  };

  it("parses amounts written as strings or safe integers, and checksums addresses", () => {
    const f = parseEpochFile(raw, "rewards/2.json");
    expect(f).toMatchObject({ epoch: 2n, token: TOKEN, total: 300n, claimDeadline: NOW, kind: "referral" });
    expect(f.claims[0]).toEqual({ account: ALICE, amount: 100n, proof: [`0x${"22".repeat(32)}`] });
  });

  it("refuses malformed files with a plain sentence naming the file and field", () => {
    const bad = (patch: object, msg: RegExp) =>
      expect(() => parseEpochFile({ ...raw, ...patch }, "f.json")).toThrow(msg);
    bad({ epoch: "x" }, /f\.json: "epoch" must be a whole number/);
    bad({ token: "0x12" }, /"token" must be an address/);
    bad({ root: "0x12" }, /"root" must be a 32-byte hex value/);
    bad({ claims: {} }, /"claims" must be a list/);
    bad({ total: "299" }, /add up to more than the total/);
    bad({ claims: [raw.claims[0], raw.claims[0]] }, /appears twice/);
    bad({ claims: [{ account: ALICE, amount: "1", proof: ["0x1"] }] }, /claims\[0\]\.proof\[0\]/);
    expect(() => parseEpochFile([], "f.json")).toThrow(EpochFileError);
  });

  it("reads a list of files and keeps going past a bad one", () => {
    const out = parseEpochFiles([raw, { ...raw, epoch: -1 }], "https://rewards.example/all.json");
    expect(out.files).toHaveLength(1);
    expect(out.errors[0]).toMatch(/^https:\/\/rewards\.example\/all\.json #2: "epoch"/);
  });

  it("serializes for a server component and parses back the same", () => {
    const f = makeEpoch(5n, [
      { account: ALICE, amount: 10n },
      { account: BOB, amount: 20n },
    ]);
    const round = parseEpochFile(serializeEpoch(f), f.source);
    expect(round).toEqual(f);
  });

  it("loads public/rewards/*.json, newest epoch first, and reports files it could not read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rewards-"));
    await writeFile(
      join(dir, "1.json"),
      JSON.stringify(serializeEpoch(makeEpoch(1n, [{ account: ALICE, amount: 1n }]))),
    );
    await writeFile(
      join(dir, "2.json"),
      JSON.stringify(serializeEpoch(makeEpoch(2n, [{ account: BOB, amount: 2n }]))),
    );
    await writeFile(join(dir, "broken.json"), "{");
    await writeFile(join(dir, "notes.txt"), "ignored");
    const loaded = await loadPublishedEpochs(dir);
    expect(loaded.epochs.map((e) => e.epoch)).toEqual(["2", "1"]);
    expect(loaded.errors).toEqual(["rewards/broken.json: not valid JSON."]);
    expect(await loadPublishedEpochs(join(dir, "missing"))).toEqual({ epochs: [], errors: [] });
  });
});

describe("claimStatus", () => {
  const file = makeEpoch(4n, [
    { account: ALICE, amount: 100n },
    { account: BOB, amount: 200n },
  ]);

  it("is claimable when the proof holds, the root matches onchain and the window is open", () => {
    const st = claimStatus(file, ALICE, onchainFor(file), false, NOW);
    expect(st.state).toBe("claimable");
    expect(st.claim?.amount).toBe(100n);
  });

  it("covers every other state", () => {
    expect(claimStatus(file, CAROL, onchainFor(file), false, NOW).state).toBe("none");
    expect(claimStatus(file, ALICE, onchainFor(file), true, NOW).state).toBe("claimed");
    expect(claimStatus(file, ALICE, null, false, NOW).state).toBe("not-onchain");
    expect(
      claimStatus(file, ALICE, onchainFor(file, { root: `0x${"00".repeat(32)}` as Hex }), false, NOW).state,
    ).toBe("not-onchain");
    expect(
      claimStatus(file, ALICE, onchainFor(file, { root: `0x${"33".repeat(32)}` as Hex }), false, NOW).state,
    ).toBe("root-mismatch");
    expect(claimStatus(file, ALICE, onchainFor(file, { token: BOB }), false, NOW).state).toBe(
      "root-mismatch",
    );
    expect(
      claimStatus(file, ALICE, onchainFor(file, { claimDeadline: BigInt(NOW - 1) }), false, NOW).state,
    ).toBe("expired");
    expect(claimStatus(file, ALICE, onchainFor(file, { swept: true }), false, NOW).state).toBe("expired");
    const tampered = { ...file, claims: file.claims.map((c) => ({ ...c, amount: c.amount + 1n })) };
    expect(claimStatus(tampered, ALICE, onchainFor(file), false, NOW).state).toBe("bad-proof");
  });
});
