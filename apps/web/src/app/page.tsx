import type { Metadata } from "next";
import { LandingLive } from "@/components/landing/LandingLive";
import { appDeployment, appNetwork } from "@/lib/config";
import { landingRead } from "@/lib/served/load";

const TITLE = "Hunch Book: prediction markets that graduate to an onchain order book";
const DESCRIPTION =
  "Prediction markets on Monad that start as USDC pools and graduate to an onchain order book, so you can sell before the answer. They settle by reading the chain; no one decides the outcome by hand.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, siteName: "Hunch Book", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

// The live panel is read from the chain on the server, then this page is regenerated at most every 30
// seconds. Its markets come from the server's cached read (lib/served), the one /markets and /proof use.
export const revalidate = 30;

export default async function Home() {
  const live = await landingRead(appNetwork, appDeployment, 12_000);
  return <LandingLive initial={live} />;
}
