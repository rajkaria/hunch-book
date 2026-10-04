import type { Metadata } from "next";
import { FeedView } from "@/components/feed/FeedDeck";
import { PageHeader } from "@/components/PageHeader";
import { NotDeployed } from "@/components/states";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";

export const metadata: Metadata = {
  title: "Feed",
  description:
    "Open Hunch Book markets one card at a time: swipe right for YES, left for NO, up to skip. YES and NO open the ticket.",
};

export default function FeedPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={appNetworkLabel} title="Feed" />
      {isDeployed(appDeployment) ? <FeedView /> : <NotDeployed />}
    </div>
  );
}
