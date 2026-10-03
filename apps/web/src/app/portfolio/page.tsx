import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { NotDeployed } from "@/components/states";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";
import { PORTFOLIO_WILL_SHOW } from "@/lib/copy";

export const metadata: Metadata = {
  title: "Portfolio",
  description:
    "Your Hunch Book stakes, claimable YES and NO tokens, and claimable pool payouts, read from the chain.",
};

export default function PortfolioPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={appNetworkLabel} title="Portfolio">
        <p>
          What your wallet staked, the tokens it can claim after graduation, and pool payouts after
          settlement.
        </p>
      </PageHeader>
      {isDeployed(appDeployment) ? <PortfolioView /> : <NotDeployed willShow={PORTFOLIO_WILL_SHOW} />}
    </div>
  );
}
