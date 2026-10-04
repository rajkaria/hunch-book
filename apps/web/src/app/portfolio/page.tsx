import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { PORTFOLIO_WILL_SHOW } from "@/lib/copy";

export const metadata: Metadata = {
  title: "Portfolio",
  description:
    "Your Hunch Book stakes, YES and NO tokens, redemptions and pool payouts, read from the chain, with one-click claims.",
};

export default function PortfolioPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Portfolio">
        <p>
          What your wallet staked, the tokens it holds and can claim, what it can redeem now, and pool payouts
          after settlement. Claim and redeem from here, one market at a time or all at once.
        </p>
      </PageHeader>
      <DeployedGate willShow={PORTFOLIO_WILL_SHOW}>
        <PortfolioView />
      </DeployedGate>
    </div>
  );
}
