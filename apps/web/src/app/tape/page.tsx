import type { Metadata } from "next";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { NotDeployed } from "@/components/states";
import { TapeView } from "@/components/tape/TapeView";
import { parseAddressParam } from "@/lib/address";
import { appDeployment, isDeployed } from "@/lib/config";

export const metadata: Metadata = {
  title: "Trade tape",
  description:
    "Every fill on Hunch Book's Kuru order books as it happens: price, size, side, block and transaction, with Hunch's own maker labelled.",
};

const TAPE_WILL_SHOW = [
  "Every fill on each graduated market's Kuru book, newest first, updated every two seconds.",
  "Price, size, side, block number and transaction, with Hunch's own maker bot labelled.",
];

export default async function TapePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { market } = await searchParams;
  const focus = typeof market === "string" ? (parseAddressParam(market) ?? undefined) : undefined;
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Trade tape">
        <p>
          Every fill on Hunch Book's order books, live. Each one shows its block and transaction, so you can
          check it on the explorer. Fills against Hunch's own maker bot are labelled ours.
        </p>
      </PageHeader>
      {isDeployed(appDeployment) ? <TapeView market={focus} /> : <NotDeployed willShow={TAPE_WILL_SHOW} />}
    </div>
  );
}
