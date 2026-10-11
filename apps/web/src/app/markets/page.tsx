import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { MarketsHeader } from "@/components/markets/MarketsHeader";
import { MarketsView } from "@/components/markets/MarketsView";
import { MARKETS_WILL_SHOW } from "@/lib/copy";
import { parseVenueFilter } from "@/lib/market/explorer";
import { parsePhaseGroup } from "@/lib/market/logic";

export const metadata: Metadata = {
  title: "Markets",
  description:
    "Yes/no markets on Monad that start as USDC pools and graduate to an onchain order book. Filter by pools filling, trading, settling and settled, and by book venue: Kuru or Hunch Book's own.",
};

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { phase, venue } = await searchParams;
  return (
    <div className="page">
      <MarketsHeader eyebrow={<ActiveNetworkLabel />} title="Markets">
        <p>
          Yes/no questions that settle by reading the chain. Each one starts as a USDC pool. Once the pool
          proves demand, it graduates to its own YES/USDC order book, fully onchain, so you can sell before
          the answer.
        </p>
      </MarketsHeader>
      <DeployedGate willShow={MARKETS_WILL_SHOW}>
        <MarketsView filter={parsePhaseGroup(phase)} venue={parseVenueFilter(venue)} />
      </DeployedGate>
    </div>
  );
}
