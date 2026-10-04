// MerkleDistributor: reward epochs, the claims against them, sweeps after the deadline, per-token totals
// and the funder role.
import { describe, expect, it } from "vitest";
import { ADDR, ALICE, BOB, CAROL, Protocol, USDC } from "./helpers.js";

const DEADLINE = 1_800_000_000n;
const OTHER_TOKEN = "0x00000000000000000000000000000000000000ee";

async function scenario() {
  const p = new Protocol();
  p.s.next({ blocks: 190_000, from: ADDR.guardian });
  // The distributor's constructor names its funder.
  p.s.emit(
    "MerkleDistributor",
    "FunderTransferred",
    { previous: ADDR.zero, current: ADDR.guardian },
    ADDR.merkleDistributor,
  );
  p.s.next({ from: ADDR.guardian });
  p.createEpoch({ epoch: 1n, token: ADDR.usdc, total: USDC(100), claimDeadline: DEADLINE });
  p.s.next({ from: ADDR.guardian });
  p.createEpoch({ epoch: 2n, token: OTHER_TOKEN, total: 5_000n, claimDeadline: DEADLINE + 1n });
  p.s.next({ from: ALICE });
  p.claimReward({ epoch: 1n, account: ALICE, amount: USDC(60), caller: ALICE });
  p.s.next({ from: ADDR.keeper });
  p.claimReward({ epoch: 1n, account: BOB, amount: USDC(25), caller: ADDR.keeper }); // our keeper submits Bob's
  p.claimReward({ epoch: 2n, account: ADDR.maker, amount: 1_000n, caller: ADDR.keeper });
  p.s.next({ seconds: 30 * 86_400, from: ADDR.guardian });
  p.sweepEpoch({ epoch: 1n, to: ADDR.guardian, amount: USDC(15) });
  p.s.next({ from: ADDR.guardian });
  p.s.emit(
    "MerkleDistributor",
    "FunderTransferStarted",
    { current: ADDR.guardian, pending: CAROL },
    ADDR.merkleDistributor,
  );
  await p.run();
  return p;
}

describe("reward epochs", () => {
  it("track each epoch's claims, sweep and what is still owed", async () => {
    const p = await scenario();
    expect(await p.indexer.RewardEpoch.getOrThrow("1")).toMatchObject({
      epoch: 1n,
      distributor: ADDR.merkleDistributor,
      token: ADDR.usdc,
      root: `0x${"11".repeat(32)}`,
      total: USDC(100),
      claimDeadline: DEADLINE,
      claimed: USDC(85),
      claimCount: 2,
      swept: true,
      sweptAmount: USDC(15),
      sweptTo: ADDR.guardian,
      outstanding: 0n,
      funder: ADDR.guardian,
    });
    expect(await p.indexer.RewardEpoch.getOrThrow("2")).toMatchObject({
      claimed: 1_000n,
      swept: false,
      outstanding: 4_000n,
    });
    expect(await p.indexer.RewardClaim.getOrThrow(`1-${BOB}`)).toMatchObject({
      epoch_id: "1",
      account: BOB,
      accountIsOurs: false,
      amount: USDC(25),
      caller: ADDR.keeper,
      callerIsOurs: true,
    });
    // Our maker bot is labelled when it appears in a tree.
    expect((await p.indexer.RewardClaim.getOrThrow(`2-${ADDR.maker}`)).accountIsOurs).toBe(true);
    expect(await p.indexer.RewardToken.getOrThrow(ADDR.usdc)).toMatchObject({
      epochCount: 1,
      funded: USDC(100),
      claimed: USDC(85),
      swept: USDC(15),
      outstanding: 0n,
    });
    expect(await p.indexer.RewardToken.getOrThrow(OTHER_TOKEN)).toMatchObject({
      funded: 5_000n,
      outstanding: 4_000n,
    });
    expect(await p.indexer.RewardDistributor.getOrThrow(ADDR.merkleDistributor)).toMatchObject({
      funder: ADDR.guardian,
      funderIsOurs: true,
      pendingFunder: CAROL,
    });
    expect(await p.indexer.ProtocolStats.getOrThrow("10143")).toMatchObject({
      rewardEpochs: 2,
      rewardClaimCount: 3,
    });
  });

  it("complete a funder handover", async () => {
    const p = await scenario();
    p.s.next({ from: CAROL });
    p.s.emit(
      "MerkleDistributor",
      "FunderTransferred",
      { previous: ADDR.guardian, current: CAROL },
      ADDR.merkleDistributor,
    );
    await p.run();
    expect(await p.indexer.RewardDistributor.getOrThrow(ADDR.merkleDistributor)).toMatchObject({
      funder: CAROL,
      funderIsOurs: false,
      pendingFunder: undefined,
    });
  });
});
