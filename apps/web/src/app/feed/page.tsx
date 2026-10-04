import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { FeedView } from "@/components/feed/FeedDeck";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = {
  title: "Feed",
  description:
    "Open Hunch Book markets one card at a time: swipe right for YES, left for NO, up to skip. YES and NO open the ticket.",
};

export default function FeedPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Feed" />
      <DeployedGate>
        <FeedView />
      </DeployedGate>
    </div>
  );
}
