import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { SettlementsView } from "@/components/settlements/SettlementsView";

export const metadata: Metadata = {
  title: "Settlement archive",
  description:
    "Every settled or voided Hunch Book market with the exact onchain read that settled it, the transaction, and whether the read still reproduces. Downloadable as CSV.",
};

const ARCHIVE_WILL_SHOW = [
  "Every settled or voided market, newest settlement first.",
  "The read that settled it, the transaction and who sent it, and a button to re-run the read.",
];

export default function SettlementsPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Settlement archive">
        <p>
          Every finished market with the onchain read that settled it. Each one links to the verifier, which
          re-runs that read from your browser, and the whole archive downloads as CSV for your own checks.
        </p>
      </PageHeader>
      <DeployedGate willShow={ARCHIVE_WILL_SHOW}>
        <SettlementsView />
      </DeployedGate>
    </div>
  );
}
