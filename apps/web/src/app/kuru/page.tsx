import type { Metadata } from "next";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { MarketsHeader } from "@/components/markets/MarketsHeader";
import { MarketsView } from "@/components/markets/MarketsView";
import { MARKETS_WILL_SHOW } from "@/lib/copy";
import { KURU_PRESET } from "@/lib/market/explorer";
import { parsePhaseGroup } from "@/lib/market/logic";

const KURU_URL = "https://www.kuru.io";

export const metadata: Metadata = {
  title: "Kuru markets",
  description:
    "Hunch Book markets whose YES/USDC books are on Kuru's onchain order book, from pools filling to settled.",
};

/** The markets list with the venue set to Kuru: /kuru, and /kuru?phase=trading and so on. */
export default async function KuruMarketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { phase } = await searchParams;
  return (
    <div className="page">
      <MarketsHeader eyebrow={<ActiveNetworkLabel />} title="Kuru markets">
        <p>
          Hunch Book markets whose YES/USDC books are on Kuru's onchain order book. Pools that have not
          graduated yet are listed too: their books will open on Kuru.{" "}
          <a href={KURU_URL} target="_blank" rel="noreferrer">
            Visit Kuru<span aria-hidden="true"> ↗</span>
          </a>
        </p>
      </MarketsHeader>
      <DeployedGate willShow={MARKETS_WILL_SHOW}>
        <MarketsView filter={parsePhaseGroup(phase)} preset={KURU_PRESET} />
      </DeployedGate>
    </div>
  );
}
