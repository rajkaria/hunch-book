import type { Deployment } from "@hunch-book/shared";
import type { Address } from "viem";
import { AddressLink, KeyValues } from "../ui";
import s from "./status.module.css";

export interface ContractGroup {
  title: string;
  items: { label: string; address: Address }[];
}

const RESOLVER_LABEL: Record<string, string> = {
  perplFunding: "Resolver 1: Perpl funding",
  priceAtTime: "Resolver 2: price at a time",
  chainlinkTouch: "Resolver 3: price touch",
  perplFundingSpike: "Resolver 4: Perpl funding spike",
  priceRange: "Resolver 5: price range",
  marketOutcome: "Resolver 6: parlay",
};

const PERIPHERY_LABEL: Record<string, string> = {
  autoRedeemer: "Auto-redeemer",
  conditionalOrders: "Conditional orders",
  referralRegistry: "Referral registry",
  merkleDistributor: "Rewards distributor",
  impliedProbabilityOracle: "Implied-probability oracle",
  priceAdapterFactory: "Price adapter factory",
  templateTimelock: "Template timelock",
};

const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Every address in deployments/<network>.json, grouped. */
export function contractGroups(d: Deployment): ContractGroup[] {
  const h = d.hunchBook;
  const core = (
    [
      ["Factory", h.factory],
      ["Collateral vault", h.vault],
      ["Market implementation", h.marketImplementation],
      ["Graduator", h.graduator],
      ["Router", h.router],
      ["USDC", h.usdc ?? d.external.usdc],
    ] as const
  ).flatMap(([label, address]) => (isAddress(address) ? [{ label, address }] : []));
  const resolvers = Object.entries(h.resolvers ?? {}).flatMap(([key, address]) =>
    isAddress(address) ? [{ label: RESOLVER_LABEL[key] ?? key, address }] : [],
  );
  const periphery = Object.entries(h.periphery ?? {}).flatMap(([key, address]) =>
    PERIPHERY_LABEL[key] && isAddress(address) ? [{ label: PERIPHERY_LABEL[key] as string, address }] : [],
  );
  const ours = (
    [
      ["Keeper (ours)", d.wallets.keeper],
      ["Maker bot (ours)", d.wallets.maker],
      ["Guardian", h.guardian],
      ["Fee recipient", h.feeRecipient],
    ] as const
  ).flatMap(([label, address]) => (isAddress(address) ? [{ label, address }] : []));
  const external = [
    { label: "Kuru router", address: d.external.kuru.router },
    { label: "Kuru margin account", address: d.external.kuru.marginAccount },
    { label: "Perpl Exchange", address: d.external.perpl.exchange },
    { label: "Pyth", address: d.external.pyth.contract },
    ...Object.entries(d.external.chainlink).map(([pair, address]) => ({
      label: `Chainlink ${pair}`,
      address,
    })),
  ].filter((x) => isAddress(x.address));
  return [
    { title: "Hunch Book core", items: core },
    { title: "Resolvers", items: resolvers },
    { title: "Periphery", items: periphery },
    { title: "Our wallets and roles", items: ours },
    { title: "Outside contracts it reads or trades on", items: external },
  ].filter((g) => g.items.length > 0);
}

export function ContractLinks({ deployment }: { deployment: Deployment }) {
  return (
    <div className={s.contracts}>
      {contractGroups(deployment).map((g) => (
        <div key={g.title}>
          <p className={s.groupTitle}>{g.title}</p>
          <KeyValues
            items={g.items.map((item) => ({
              key: `${g.title}-${item.label}`,
              label: item.label,
              value: <AddressLink address={item.address} />,
            }))}
          />
        </div>
      ))}
    </div>
  );
}
