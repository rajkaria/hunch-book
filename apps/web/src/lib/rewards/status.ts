import { type Address, isAddressEqual } from "viem";
import { formatUtc } from "../format";
import { claimOf, claimVerifies, type EpochClaim, type EpochFile } from "./epochs";

// Whether a wallet can claim from one published epoch right now, combining the file with what the
// MerkleDistributor says about that epoch onchain.

/** MerkleDistributor.epochs(epoch), or null when the read failed. An epoch that was never created reads as zeros. */
export interface OnchainEpoch {
  token: Address;
  claimDeadline: bigint;
  swept: boolean;
  root: `0x${string}`;
  total: bigint;
  claimed: bigint;
}

export type ClaimState =
  | "claimable"
  | "claimed"
  | "none"
  | "bad-proof"
  | "not-onchain"
  | "root-mismatch"
  | "expired";

export interface ClaimStatus {
  state: ClaimState;
  claim: EpochClaim | null;
  /** One sentence about the state. */
  note: string;
}

const ZERO_ROOT = `0x${"00".repeat(32)}`;

export function claimStatus(
  file: EpochFile,
  account: Address,
  onchain: OnchainEpoch | null,
  claimed: boolean,
  now: number,
): ClaimStatus {
  const claim = claimOf(file, account);
  if (!claim) return { state: "none", claim: null, note: "This wallet has nothing in this epoch." };
  if (!claimVerifies(file, claim)) {
    return {
      state: "bad-proof",
      claim,
      note: "The proof in the file does not lead to the file's own root, so it cannot be claimed.",
    };
  }
  if (!onchain || onchain.root.toLowerCase() === ZERO_ROOT) {
    return {
      state: "not-onchain",
      claim,
      note: "This epoch is published but not created onchain yet. Claims open once it is funded.",
    };
  }
  if (onchain.root.toLowerCase() !== file.root.toLowerCase() || !isAddressEqual(onchain.token, file.token)) {
    return {
      state: "root-mismatch",
      claim,
      note: "The file's root or token differs from the one onchain for this epoch. Do not trust this file.",
    };
  }
  if (claimed) return { state: "claimed", claim, note: "Claimed. The tokens went to this wallet." };
  if (onchain.swept || BigInt(Math.floor(now)) > onchain.claimDeadline) {
    return {
      state: "expired",
      claim,
      note: `The claim window closed on ${formatUtc(onchain.claimDeadline)}.`,
    };
  }
  return {
    state: "claimable",
    claim,
    note: `Claim by ${formatUtc(onchain.claimDeadline)}. Anyone can submit it; the tokens always go to this wallet.`,
  };
}

export const CLAIM_STATE_LABEL: Record<ClaimState, string> = {
  claimable: "Ready to claim",
  claimed: "Claimed",
  none: "Not in this epoch",
  "bad-proof": "Proof does not verify",
  "not-onchain": "Not funded yet",
  "root-mismatch": "Root mismatch",
  expired: "Window closed",
};
