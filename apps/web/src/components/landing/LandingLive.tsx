"use client";

import type { Network } from "@hunch-book/shared";
import { useQuery } from "@tanstack/react-query";
import { getPublicClient } from "@/lib/chain/client";
import { type LandingRead, readLandingSnapshot } from "@/lib/chain/landing";
import { appDeployment, buildNetwork, isDeployed } from "@/lib/config";
import { fetchServed } from "@/lib/served/fetch";
import { useAppNetwork } from "@/lib/wallet/appNetwork";
import { Landing } from "./Landing";

/** The live figures for a network the page was not rendered for: the server's cached read, else read here. */
async function readOtherNetwork(network: Network): Promise<LandingRead> {
  const deployment = appDeployment;
  const readHere = () => readLandingSnapshot(getPublicClient(), deployment);
  // Nothing deployed: the answer needs no read at all.
  if (!isDeployed(deployment)) return readHere();
  return fetchServed<LandingRead>("landing", network).then((served) => served.data, readHere);
}

/** The live figures for a network the server did not render, refreshed every 30 seconds. */
function OtherNetworkLanding({ network }: { network: Network }) {
  const query = useQuery({
    queryKey: ["landing", network],
    queryFn: () => readOtherNetwork(network),
    refetchInterval: 30_000,
  });
  const live: LandingRead = query.data ?? { status: "loading" };
  return <Landing live={live} />;
}

/**
 * The landing page with live figures for the active network. The server reads the build's network
 * (`initial`, regenerated every 30 seconds); after a switch to another network in this browser, the
 * page reads that network itself.
 */
export function LandingLive({ initial }: { initial: LandingRead }) {
  const network = useAppNetwork();
  if (network === buildNetwork) return <Landing live={initial} />;
  return <OtherNetworkLanding network={network} />;
}
