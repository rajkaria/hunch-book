import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import s from "@/components/page.module.css";
import { AddressLink, Badge, KeyValues, Notice, Panel } from "@/components/ui";
import { appDeployment, appNetworkLabel, factoryOf } from "@/lib/config";

export const metadata: Metadata = {
  title: "Proof",
  description:
    "What Hunch Book will measure from the chain: markets, wallets, trades, volume and the share of fills against Hunch's own maker. Numbers come from the indexer once it is live.",
};

const MEASURES: { name: string; how: string }[] = [
  { name: "Markets", how: "every market created by the factory, by phase" },
  { name: "Wallets", how: "distinct addresses that staked or traded" },
  { name: "Trades", how: "fills on each graduated market's Kuru YES/USDC book" },
  { name: "Volume", how: "USDC staked in pools plus USDC traded on the books" },
  {
    name: "Maker share",
    how: "the share of book fills taken by Hunch's own maker, counted apart from everyone else",
  },
];

export default function ProofPage() {
  const { maker, keeper } = appDeployment.wallets;
  const factory = factoryOf(appDeployment);
  return (
    <div className="page">
      <PageHeader eyebrow={appNetworkLabel} title="Proof" aside={<Badge tone="warn">planned</Badge>}>
        <p>
          Usage numbers for Hunch Book, counted from the chain. None are shown yet: they come from the indexer
          once it is live, and each one will link to the transactions behind it.
        </p>
      </PageHeader>

      <div className={s.stack}>
        <Panel title="What will be measured" labelledBy="measures-title">
          <ul className={s.list}>
            {MEASURES.map((m) => (
              <li key={m.name}>
                <strong>{m.name}</strong>: {m.how}.
              </li>
            ))}
          </ul>
        </Panel>

        <Notice tone="accent" title="No numbers yet">
          <p className="muted">
            The indexer that counts these is being built. Until it is live this page shows no figures, not
            estimates.
          </p>
        </Notice>

        <Panel title="Our own wallets" labelledBy="ours-title">
          <p className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
            These addresses belong to Hunch. Their activity is labelled as ours wherever it is counted, so it
            never inflates the numbers above.
          </p>
          <KeyValues
            items={[
              { label: "Maker bot (ours)", value: <AddressLink address={maker} full /> },
              { label: "Keeper (ours)", value: <AddressLink address={keeper} full /> },
              {
                label: "Factory",
                value: factory ? (
                  <AddressLink address={factory} full />
                ) : (
                  <span className="subtle">not deployed yet</span>
                ),
              },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}
