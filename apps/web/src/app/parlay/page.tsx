import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { ParlayPage } from "@/components/parlay/ParlayView";

export const metadata: Metadata = {
  title: "Parlays",
  description:
    "Combine 2 to 5 Hunch Book markets into one: YES only if every leg settles YES. See the implied chance, then create it.",
};

export default function ParlayRoute() {
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Parlays">
        <p>
          One market on several: it settles YES only if every leg settles YES, and NO the moment any leg
          settles NO. It reads the legs' own outcomes, so it settles from the chain like they do.
        </p>
      </PageHeader>
      <DeployedGate>
        <ParlayPage />
      </DeployedGate>
    </div>
  );
}
