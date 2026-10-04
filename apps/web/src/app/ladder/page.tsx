import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { LadderView } from "@/components/ladder/LadderView";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = {
  title: "Ladders",
  description:
    "Markets that ask the same question at different strikes, drawn as one curve: the market's implied chance at every price.",
};

export default function LadderPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Ladders">
        <p>
          Markets with the same question, asset and window, at different strikes or thresholds. Together their
          chances draw the market's own probability curve: how likely YES is at each price. Every point is a
          market's live price, not a model.
        </p>
      </PageHeader>
      <DeployedGate>
        <LadderView />
      </DeployedGate>
    </div>
  );
}
