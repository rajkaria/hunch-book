import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { NotDeployed } from "@/components/states";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";
import { PORTFOLIO_WILL_SHOW } from "@/lib/copy";

export const metadata: Metadata = {
  title: "Portfolio",
  description:
    "Your Hunch Book stakes, YES and NO tokens, redemptions and pool payouts, read from the chain, with one-click claims.",
};

export default function PortfolioPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={appNetworkLabel} title="Portfolio">
        <p>
          What your wallet staked, the tokens it holds and can claim, what it can redeem now, and pool payouts
          after settlement. Claim and redeem from here, one market at a time or all at once.
        </p>
      </PageHeader>
      {isDeployed(appDeployment) ? <PortfolioView /> : <NotDeployed willShow={PORTFOLIO_WILL_SHOW} />}
    </div>
  );
}
