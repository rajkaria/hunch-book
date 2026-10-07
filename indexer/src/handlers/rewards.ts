// MerkleDistributor (docs/PERIPHERY.md): reward epochs (referral shares and maker rewards), the claims
// against them, sweeps of what was left after the deadline, and the funder role.
import { indexer } from "envio";
import { addr, scopedId } from "../lib/network.js";
import { Unit } from "../lib/store.js";

function tokenOf(u: Unit, token: string) {
  const id = addr(token);
  return u.load("RewardToken", id, () => ({
    id,
    epochCount: 0,
    funded: 0n,
    claimed: 0n,
    swept: 0n,
    outstanding: 0n,
  }));
}

indexer.onEvent({ contract: "MerkleDistributor", event: "EpochCreated" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const { epoch, root, total, claimDeadline } = event.params;
  // Each stack's distributor numbers its own epochs.
  const id = scopedId(u.m.chainId, u.m.src, epoch.toString());
  if (await u.exists("RewardEpoch", id)) return;
  const token = addr(event.params.token);
  u.create("RewardEpoch", {
    id,
    epoch,
    distributor: u.m.src,
    token,
    root,
    total,
    claimDeadline,
    claimed: 0n,
    claimCount: 0,
    swept: false,
    sweptAmount: 0n,
    sweptTo: undefined,
    sweptAt: undefined,
    sweepTx: undefined,
    outstanding: total,
    funder: u.m.from,
    createdAt: u.m.timestamp,
    createdAtBlock: u.m.block,
    createdTx: u.m.tx,
  });
  const t = await tokenOf(u, token);
  t.epochCount += 1;
  t.funded += total;
  (await u.stats()).rewardEpochs += 1;
  u.flush();
});

indexer.onEvent({ contract: "MerkleDistributor", event: "Claimed" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const { epoch, amount } = event.params;
  const account = addr(event.params.account);
  const caller = addr(event.params.caller);
  // One claim per account per epoch, onchain: the pair is the record's id and its guard.
  const epochId = scopedId(u.m.chainId, u.m.src, epoch.toString());
  const id = `${epochId}-${account}`;
  if (await u.exists("RewardClaim", id)) return;
  u.create("RewardClaim", {
    id,
    epoch_id: epochId,
    account,
    accountIsOurs: await u.isOurs(account),
    amount,
    caller,
    callerIsOurs: await u.isOurs(caller),
    block: u.m.block,
    timestamp: u.m.timestamp,
    tx: u.m.tx,
  });
  const e = await u.find("RewardEpoch", epochId);
  if (e) {
    e.claimed += amount;
    e.claimCount += 1;
    (await tokenOf(u, e.token)).claimed += amount;
  } else {
    u.log.warn("claim in an epoch the indexer has not seen", { epoch: epoch.toString(), event: u.m.id });
  }
  (await u.stats()).rewardClaimCount += 1;
  (await u.daily()).rewardClaimCount += 1;
  u.flush();
});

indexer.onEvent({ contract: "MerkleDistributor", event: "Swept" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const { epoch, amount } = event.params;
  const e = await u.find("RewardEpoch", scopedId(u.m.chainId, u.m.src, epoch.toString()));
  if (!e || e.swept) return; // unknown, or swept before (once per epoch onchain)
  e.swept = true;
  e.sweptAmount = amount;
  e.sweptTo = addr(event.params.to);
  e.sweptAt = u.m.timestamp;
  e.sweepTx = u.m.tx;
  (await tokenOf(u, e.token)).swept += amount;
  u.flush();
});

async function distributorOf(u: Unit) {
  return u.load("RewardDistributor", u.m.src, () => ({
    id: u.m.src,
    funder: "",
    pendingFunder: undefined,
    funderIsOurs: false,
    updatedAt: u.m.timestamp,
    updatedTx: u.m.tx,
  }));
}

// The funder role only changes hands; replaying these events in order always ends in the same state.
indexer.onEvent(
  { contract: "MerkleDistributor", event: "FunderTransferStarted" },
  async ({ event, context }) => {
    const u = new Unit(context, event);
    const d = await distributorOf(u);
    d.funder = addr(event.params.current);
    d.funderIsOurs = await u.isOurs(d.funder);
    d.pendingFunder = addr(event.params.pending);
    d.updatedAt = u.m.timestamp;
    d.updatedTx = u.m.tx;
    u.flush();
  },
);

indexer.onEvent({ contract: "MerkleDistributor", event: "FunderTransferred" }, async ({ event, context }) => {
  const u = new Unit(context, event);
  const d = await distributorOf(u);
  d.funder = addr(event.params.current);
  d.funderIsOurs = await u.isOurs(d.funder);
  d.pendingFunder = undefined;
  d.updatedAt = u.m.timestamp;
  d.updatedTx = u.m.tx;
  u.flush();
});
