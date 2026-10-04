import type { Metadata } from "next";
import { HedgeView } from "@/components/hedge/HedgeView";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { Badge, InlineHelp } from "@/components/ui";
import { REPO_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Hedge funding",
  description:
    "Read a Perpl position, see the funding it pays and what it is projected to pay, and size a Hunch Book market that pays out if funding stays high.",
};

export default function HedgePage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow={<ActiveNetworkLabel />}
        title="Hedge your funding"
        aside={<Badge tone="warn">building</Badge>}
      >
        <p>
          A long on Perpl pays funding while longs pay shorts. Read your positions, see what each one pays now
          and what it would pay if the rate holds, and size a market that pays out if funding stays high.
        </p>
      </PageHeader>
      <div style={{ marginBottom: 24 }}>
        <InlineHelp summary="How this works, and what it does not do">
          <p>
            Positions and funding come straight from Perpl's Exchange contract: getAccountByAddr,
            getPositionV2 and getFundingSumAtBlock. The projection assumes the rate holds; funding changes
            every interval, so treat it as an estimate. A hedge pays only if its market settles on your side;
            if it does not, you lose what you put in. Perpl's funding rates are set by Perpl's own price
            administrator, and every Perpl market pays on what Perpl records.{" "}
            <a href={`${REPO_URL}/blob/main/docs/HEDGE.md`} target="_blank" rel="noreferrer">
              The math, step by step
            </a>
            .
          </p>
        </InlineHelp>
      </div>
      <HedgeView />
    </div>
  );
}
