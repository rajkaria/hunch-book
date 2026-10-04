import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ReferralLanding } from "@/components/referral/ReferralLanding";
import { parseAddressParam } from "@/lib/address";
import { appNetworkLabel } from "@/lib/config";
import { DESCRIPTION } from "@/lib/copy";
import { marketInPath, safeNextPath } from "@/lib/referral/link";

type Props = {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** A referral link to a market unfurls with that market's card. */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const referrer = parseAddressParam((await params).address);
  if (!referrer) return { title: "Referral link not found" };
  const market = marketInPath(safeNextPath((await searchParams).next));
  const title = "You are invited to Hunch Book";
  return {
    title,
    description: DESCRIPTION,
    robots: { index: false },
    ...(market
      ? {
          openGraph: { title, description: DESCRIPTION, images: [`/m/${market}/opengraph-image`] },
          twitter: { card: "summary_large_image", title, images: [`/m/${market}/opengraph-image`] },
        }
      : {}),
  };
}

export default async function ReferralPage({ params, searchParams }: Props) {
  const referrer = parseAddressParam((await params).address);
  if (!referrer) notFound();
  const next = safeNextPath((await searchParams).next);
  return (
    <div className="page">
      <PageHeader eyebrow={appNetworkLabel} title="You are invited to Hunch Book">
        <p>{DESCRIPTION}</p>
      </PageHeader>
      <ReferralLanding referrer={referrer} next={next} />
    </div>
  );
}
