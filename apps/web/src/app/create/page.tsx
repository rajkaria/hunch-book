import type { Metadata } from "next";
import { CreateFlow } from "@/components/create/CreateFlow";
import { DeployedGate } from "@/components/DeployedGate";
import { ActiveNetworkLabel } from "@/components/layout/NetworkSwitch";
import { PageHeader } from "@/components/PageHeader";
import { CREATE_DESCRIPTION, CREATE_WILL_SHOW } from "@/lib/create/copy";
import { parseCreateLink, parseCreatePrefill } from "@/lib/create/prefill";
import { parseTemplateParam } from "@/lib/create/templates";

export const metadata: Metadata = {
  title: "Create a market",
  description: CREATE_DESCRIPTION,
};

export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const { template } = query;
  return (
    <div className="page">
      <PageHeader eyebrow={<ActiveNetworkLabel />} title="Create a market">
        <p>
          Pick a template, set its parameters and read the exact rule the resolver will apply. Then make the
          first stake: the market starts as a USDC pool, and graduates to its own onchain order book once it
          proves demand.
        </p>
      </PageHeader>
      <DeployedGate willShow={CREATE_WILL_SHOW}>
        <CreateFlow
          initialTemplate={parseTemplateParam(template)}
          prefill={parseCreatePrefill(query)}
          link={parseCreateLink(query)}
        />
      </DeployedGate>
    </div>
  );
}
