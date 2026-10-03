import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import s from "@/components/page.module.css";
import { AddressLink, Badge, ButtonLink, KeyValues, Panel } from "@/components/ui";
import { appDeployment, appNetworkLabel, factoryOf, REPO_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: { absolute: "Hunch Book" },
  description:
    "Prediction markets on Monad that start as USDC pools, graduate to Kuru's onchain order book, and settle by reading the chain.",
};

// A minimal status page. The marketing landing page is a later task.
export default function Home() {
  const factory = factoryOf(appDeployment);
  return (
    <div className="page">
      <PageHeader eyebrow="Hunch Book" title="Markets that start as pools and graduate to an order book">
        <p>
          Stake USDC on YES or NO. Once a pool proves demand, it becomes fully backed YES and NO tokens
          trading on Kuru, so you can sell before the answer. Markets settle by reading Monad, not a person.
        </p>
      </PageHeader>
      <div className={s.stack}>
        <Panel title="Status" labelledBy="status-title" aside={<Badge tone="warn">building</Badge>}>
          <KeyValues
            items={[
              { label: "Network", value: appNetworkLabel },
              {
                label: "Contracts",
                value: factory ? (
                  <>
                    deployed, factory <AddressLink address={factory} />
                  </>
                ) : (
                  "not deployed yet"
                ),
              },
              { label: "App", value: "building" },
              {
                label: "Source",
                value: (
                  <a href={REPO_URL} target="_blank" rel="noreferrer">
                    github.com/rajkaria/hunch-book
                  </a>
                ),
              },
            ]}
          />
        </Panel>
        <div>
          <ButtonLink href="/markets" variant="primary">
            Go to markets
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
