import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NotDeployed } from "@/components/states";
import { VerifyView } from "@/components/verify/VerifyView";
import { parseAddressParam } from "@/lib/address";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";
import { VERIFY_WILL_SHOW } from "@/lib/copy";
import { shortAddress } from "@/lib/format";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = parseAddressParam((await params).address);
  if (!address) return { title: "Market not found" };
  return {
    title: `Verify ${shortAddress(address)}`,
    description:
      "What settled this Hunch Book market: the exact onchain read, the evidence hash, the settler, and a button that runs the read again from your browser.",
  };
}

export default async function VerifyPage({ params }: Props) {
  const address = parseAddressParam((await params).address);
  if (!address) notFound();
  return (
    <div className="page">
      <PageHeader eyebrow={`${appNetworkLabel} · Verify`} title="Settlement">
        <p>
          A market's outcome comes only from its resolver reading onchain data. This page shows the exact
          read, runs it again from your browser with no wallet, and compares it with what the market stored
          when it settled.
        </p>
      </PageHeader>
      {isDeployed(appDeployment) ? (
        <VerifyView address={address} />
      ) : (
        <NotDeployed willShow={VERIFY_WILL_SHOW} />
      )}
    </div>
  );
}
