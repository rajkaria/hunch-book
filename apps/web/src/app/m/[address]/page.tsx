import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeployedGate } from "@/components/DeployedGate";
import { Crumbs, MarketDetail } from "@/components/market/MarketDetail";
import { parseAddressParam } from "@/lib/address";
import { getPublicClient } from "@/lib/chain/client";
import { readMarketHeadline } from "@/lib/chain/reads";
import { appDeployment, isDeployed } from "@/lib/config";
import { MARKET_WILL_SHOW } from "@/lib/copy";
import { shortAddress } from "@/lib/format";

type Props = { params: Promise<{ address: string }> };

const MARKET_PAGE_DESCRIPTION =
  "A Hunch Book market on Monad: stake USDC on YES or NO, trade it on its onchain order book once it graduates, settled by reading the chain.";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = parseAddressParam((await params).address);
  if (!address) return { title: "Market not found" };
  const headline = isDeployed(appDeployment)
    ? await readMarketHeadline(getPublicClient(), appDeployment, address)
    : null;
  const title = headline ?? `Market ${shortAddress(address)}`;
  return {
    title,
    description: headline ? `${headline} ${MARKET_PAGE_DESCRIPTION}` : MARKET_PAGE_DESCRIPTION,
  };
}

export default async function MarketPage({ params }: Props) {
  const address = parseAddressParam((await params).address);
  if (!address) notFound();
  return (
    <div className="page">
      <Crumbs address={address} />
      <DeployedGate willShow={MARKET_WILL_SHOW}>
        <MarketDetail address={address} />
      </DeployedGate>
    </div>
  );
}
