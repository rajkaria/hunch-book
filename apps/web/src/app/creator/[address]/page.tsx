import { CREATOR_SHARE_BPS } from "@hunch-book/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CreatorView } from "@/components/creator/CreatorView";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { NotDeployed } from "@/components/states";
import { parseAddressParam } from "@/lib/address";
import { appDeployment, isDeployed } from "@/lib/config";
import { formatBpsPercent, shortAddress } from "@/lib/format";

type Props = { params: Promise<{ address: string }> };

const SHARE = formatBpsPercent(CREATOR_SHARE_BPS);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = parseAddressParam((await params).address);
  if (!address) return { title: "Creator not found" };
  return {
    title: `Creator ${shortAddress(address)}`,
    description: `Markets created by ${address} on Hunch Book, and the creator's ${SHARE} share of the fee on them.`,
  };
}

const CREATOR_WILL_SHOW = [
  "Every market this address created, with its stage, pool and volume.",
  `The creator's ${SHARE} share of Hunch Book's fee, what is ready to withdraw, and past withdrawals.`,
];

export default async function CreatorPage({ params }: Props) {
  const address = parseAddressParam((await params).address);
  if (!address) notFound();
  return (
    <div className="page">
      <PageHeader
        eyebrow={<ActiveNetworkLabel suffix=" · Creator" />}
        title={`Creator ${shortAddress(address)}`}
      >
        <p>
          The markets this address created, and its earnings: {SHARE} of Hunch Book's fee on each of them,
          held by the vault until the creator withdraws.
        </p>
      </PageHeader>
      {isDeployed(appDeployment) ? (
        <CreatorView creator={address} />
      ) : (
        <NotDeployed willShow={CREATOR_WILL_SHOW} />
      )}
    </div>
  );
}
