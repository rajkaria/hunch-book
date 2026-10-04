import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { ProofView } from "@/components/proof/ProofView";

export const metadata: Metadata = {
  title: "Proof",
  description:
    "Hunch Book counted from the chain: markets created, graduated, settled and voided, wallets, fills and volume split between Hunch's own maker and everyone else, settlement timing and solvency per market.",
};

const PROOF_WILL_SHOW = [
  "Markets created, graduated, settled and voided.",
  "Distinct wallets that staked or traded, with our own wallets counted apart.",
  "Fills and volume, split into fills against Hunch's maker and fills between other parties.",
  "Time from window end to settlement, and from settlement to redemption.",
  "The vault's solvency margin, and each market's.",
];

export default function ProofPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Proof">
        <p>
          Hunch Book counted from the chain. Every figure links to where it comes from: a contract on the
          explorer or the indexer query. Activity by our own maker bot, keeper and other wallets is labelled
          ours.
        </p>
      </PageHeader>
      <DeployedGate willShow={PROOF_WILL_SHOW}>
        <ProofView />
      </DeployedGate>
    </div>
  );
}
