import { buildRewardTree, formatUsdc, type RewardClaim } from "@hunch-book/sdk";
import { merkleDistributorAbi } from "@hunch-book/shared";
import { type Address, encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import type { MakerReward } from "./score.js";

// The epoch file: every account's reward for one MerkleDistributor epoch, the tree's root and each
// account's proof, ready for the funder's `createEpoch(token, root, total, claimDeadline)`. Maker
// rewards (V-5) and referral credits (C-8) go into one epoch, merged per account, so each account
// appears once in the tree, as the distributor requires. This file only describes the epoch: nothing
// here sends a transaction.

export interface EpochInput {
  network: string;
  /** The id `nextEpoch()` returns: it is inside every leaf. */
  epoch: bigint;
  token: Address;
  distributor: Address | null;
  /** Unix seconds; the distributor wants at least 7 days from creation. */
  claimDeadline: bigint;
  makers: MakerReward[];
  referrals: Map<Address, bigint>;
  /** What produced the numbers, written into the file as is. */
  programs: Record<string, unknown>;
}

export interface EpochClaim {
  account: Address;
  amount: string;
  proof: Hex[];
  /** The parts, USDC base units. */
  makerReward: string;
  referralReward: string;
}

export interface EpochFile {
  network: string;
  dryRun: true;
  epoch: string;
  token: Address;
  distributor: Address | null;
  total: string;
  totalUsdc: string;
  root: Hex | null;
  claimDeadline: string;
  claims: EpochClaim[];
  /** Our own makers: listed with what they would have earned, and paid nothing. */
  excluded: { account: Address; label: string; wouldHaveEarned: string }[];
  programs: Record<string, unknown>;
  /** What the funder sends, in order, after checking the file. */
  fund: { approve: { to: Address; data: Hex }; createEpoch: { to: Address | null; data: Hex } } | null;
}

export function buildEpoch(input: EpochInput): EpochFile {
  const maker = new Map<Address, bigint>();
  const excluded = new Map<Address, bigint>();
  for (const r of input.makers) {
    const account = getAddress(r.maker);
    if (r.ours) {
      excluded.set(account, (excluded.get(account) ?? 0n) + r.earned);
      continue;
    }
    maker.set(account, (maker.get(account) ?? 0n) + r.reward);
  }
  const referral = new Map<Address, bigint>();
  for (const [a, v] of input.referrals) referral.set(getAddress(a), (referral.get(getAddress(a)) ?? 0n) + v);
  const accounts = [...new Set([...maker.keys(), ...referral.keys()])].sort();
  const claims: RewardClaim[] = accounts
    .map((account) => ({ account, amount: (maker.get(account) ?? 0n) + (referral.get(account) ?? 0n) }))
    .filter((c) => c.amount > 0n);
  const tree = claims.length > 0 ? buildRewardTree(input.epoch, claims) : null;
  const total = tree?.total ?? 0n;
  const createData =
    tree === null
      ? null
      : encodeFunctionData({
          abi: merkleDistributorAbi,
          functionName: "createEpoch",
          args: [input.token, tree.root, total, input.claimDeadline],
        });
  return {
    network: input.network,
    dryRun: true,
    epoch: input.epoch.toString(),
    token: input.token,
    distributor: input.distributor,
    total: total.toString(),
    totalUsdc: formatUsdc(total),
    root: tree?.root ?? null,
    claimDeadline: input.claimDeadline.toString(),
    claims: (tree?.claims ?? []).map((c) => ({
      account: c.account,
      amount: c.amount.toString(),
      proof: c.proof,
      makerReward: (maker.get(c.account) ?? 0n).toString(),
      referralReward: (referral.get(c.account) ?? 0n).toString(),
    })),
    excluded: [...excluded.keys()].map((account) => ({
      account,
      label: "Hunch Book's own maker bot (ours): excluded from rewards, its share is not redistributed",
      wouldHaveEarned: (excluded.get(account) ?? 0n).toString(),
    })),
    programs: input.programs,
    fund:
      createData === null || input.distributor === null
        ? null
        : {
            approve: {
              to: input.token,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [input.distributor, total],
              }),
            },
            createEpoch: { to: input.distributor, data: createData },
          },
  };
}
