import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { StatusView } from "@/components/status/StatusView";
import { appNetworkLabel } from "@/lib/config";
import { readIncidentLog } from "@/lib/status/incidentLog";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Live checks read from the chain: the vault's USDC against everything it owes, token supply per market, settlement on time, pauses, and the keeper's and maker's health. With the incident log.",
};

// The page has no request-time data on the server, so it is built once: the incident log is read
// from docs/INCIDENTS.md at build time. Everything else is read live in the browser.
export const dynamic = "force-static";

export default function StatusPage() {
  return (
    <div className="page">
      <PageHeader eyebrow={appNetworkLabel} title="Status">
        <p>
          Is Hunch Book solvent and running right now? Every check below reads the contracts directly, with no
          server in between. Amber means something needs attention; red means a rule is broken.
        </p>
      </PageHeader>
      <StatusView incidents={readIncidentLog()} />
    </div>
  );
}
