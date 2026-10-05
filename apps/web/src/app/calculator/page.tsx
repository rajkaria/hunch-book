import type { Metadata } from "next";
import { CalculatorView } from "@/components/calculator/CalculatorView";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { Badge, InlineHelp } from "@/components/ui";
import { parseCalculatorQuery } from "@/lib/calculator/query";
import { REPO_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Funding-cost calculator",
  description:
    "What a Perpl position pays in funding over the next day, week or any horizon, from Perpl's live funding history. No wallet needed.",
};

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initial = parseCalculatorQuery(await searchParams);
  return (
    <div className="page">
      <PageHeader
        eyebrow={<ActiveNetworkLabel />}
        title="Funding-cost calculator"
        aside={<Badge tone="warn">building</Badge>}
      >
        <p>
          What a position on Perpl pays in funding if the rate holds. Pick a perp, a side, a size and how
          long. No wallet needed. Then see the Hunch Book markets that would pay out if it does.
        </p>
      </PageHeader>
      <div style={{ marginBottom: 24 }}>
        <InlineHelp summary="Where the numbers come from">
          <p>
            Funding comes straight from Perpl's Exchange contract: getPerpetualInfoV2 for the perp's decimals
            and mark price, and getFundingSumAtBlock at each of the last 48 funding events. The count of
            funding events ahead uses the block time measured on chain over the last 10,000 blocks. The math
            is the hedge assistant's.{" "}
            <a href={`${REPO_URL}/blob/main/docs/HEDGE.md`} target="_blank" rel="noreferrer">
              The math, step by step
            </a>
            .
          </p>
        </InlineHelp>
      </div>
      <CalculatorView initial={initial} />
    </div>
  );
}
