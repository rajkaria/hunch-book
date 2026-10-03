"use client";

import { Outcome, Phase } from "@hunch-book/shared";
import Link from "next/link";
import type { Address } from "viem";
import { appDeployment, appNetworkLabel } from "@/lib/config";
import { VERIFY_WILL_SHOW } from "@/lib/copy";
import { formatUtc } from "@/lib/format";
import { useMarket } from "@/lib/hooks";
import { phaseLabel } from "@/lib/market/logic";
import { describeSource, templateLabel } from "@/lib/market/params";
import type { MarketView } from "@/lib/market/types";
import { marketHeadline } from "../markets/MarketCard";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { AddressLink, Button, KeyValues, Notice, Panel } from "../ui";

const ZERO_HASH = `0x${"00".repeat(32)}`;

export function outcomeWords(m: Pick<MarketView, "phase" | "outcome">): string {
  if (m.phase === Phase.Voided) return "Voided: no answer before the settlement deadline";
  if (m.outcome === Outcome.Yes) return "YES";
  if (m.outcome === Outcome.No) return "NO";
  return "Not settled";
}

export function VerifyBody({ m }: { m: MarketView }) {
  const settled = m.phase === Phase.Settled || m.phase === Phase.Voided;
  const source = describeSource(appDeployment, m.decoded, m.resolver);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Panel title="Market" labelledBy="verify-market">
        <p style={{ fontWeight: 600, marginBottom: 12 }}>
          <Link href={`/m/${m.address}`}>{marketHeadline(m)}</Link>
        </p>
        <KeyValues
          items={[
            { label: "Market", value: <AddressLink address={m.address} full /> },
            { label: "Phase", value: phaseLabel(m.phase) },
            { label: "Template", value: `${templateLabel(m.templateId)} (id ${m.templateId})` },
            { label: "Settlement deadline", value: formatUtc(m.window.settleDeadline) },
          ]}
        />
      </Panel>

      {settled ? (
        <Panel title="What settled it" labelledBy="verify-settled">
          <KeyValues
            items={[
              { label: "Outcome", value: <strong>{outcomeWords(m)}</strong> },
              {
                label: "Evidence hash",
                value: (
                  <span className="mono">
                    {m.evidenceHash === ZERO_HASH ? "none stored" : m.evidenceHash}
                  </span>
                ),
              },
              { label: "Resolver", value: <AddressLink address={m.resolver} full /> },
              ...source.items
                .filter((item) => item.label !== "Resolver")
                .map((item) => ({
                  key: item.label,
                  label: item.label,
                  value: item.href ? (
                    <a href={item.href} target="_blank" rel="noreferrer" className="mono">
                      {item.value}
                    </a>
                  ) : (
                    <span className={item.mono ? "mono" : undefined}>{item.value}</span>
                  ),
                })),
              { label: "Raw params", value: <span className="mono">{m.params}</span> },
            ]}
          />
        </Panel>
      ) : (
        <Notice tone="warn" title="Not settled yet">
          <p>
            This market is in phase "{phaseLabel(m.phase)}". Once anyone settles it, this page shows the
            outcome, the evidence hash and the exact data the resolver read.
          </p>
        </Notice>
      )}

      <Panel title="Check it yourself" labelledBy="verify-rerun">
        <p className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
          The verifier will re-run the resolver's read from your browser, with no wallet, and compare it with
          the stored outcome. The settlement transaction and who sent it will come from the indexer.
        </p>
        <Button disabled title="Coming in the next build">
          Re-run the read
        </Button>
        <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
          Coming in the next build.
        </p>
      </Panel>
    </div>
  );
}

export function VerifyView({ address }: { address: Address }) {
  const query = useMarket(address);
  if (query.isPending) return <LoadingRows rows={2} label="Loading settlement" />;
  if (query.isError) {
    return <ErrorState title="Could not load this market" onRetry={() => void query.refetch()} />;
  }
  if (query.data.status === "not-deployed") return <NotDeployed willShow={VERIFY_WILL_SHOW} />;
  if (query.data.status === "not-market") {
    return (
      <EmptyState label="Not found" title="This address is not a Hunch Book market">
        <p>
          The factory on {appNetworkLabel} does not list <span className="mono">{address}</span>.
        </p>
      </EmptyState>
    );
  }
  return <VerifyBody m={query.data.data} />;
}
