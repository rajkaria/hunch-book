import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { RewardsView } from "@/components/rewards/RewardsView";
import { loadPublishedEpochs } from "@/lib/rewards/load";

export const metadata: Metadata = {
  title: "Rewards",
  description:
    "Claim Hunch Book maker rewards and referral shares from the rewards distributor, with the proof checked in your browser.",
};

export default async function RewardsPage() {
  const { epochs, errors } = await loadPublishedEpochs();
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Rewards">
        <p>
          Maker rewards and referral shares are paid in epochs from an onchain distributor. Each epoch
          publishes a Merkle root onchain and a file with every wallet's amount and proof. Connect a wallet to
          claim what is yours.
        </p>
      </PageHeader>
      <DeployedGate>
        <RewardsView published={epochs} errors={errors} />
      </DeployedGate>
    </div>
  );
}
