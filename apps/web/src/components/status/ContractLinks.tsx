import { type Deployment, defaultStackOf, type Stack, stacksOf } from "@hunch-book/shared";
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
  snapshot: "Resolver 7: snapshot",
};

const PERIPHERY_LABEL: Record<string, string> = {
  autoRedeemer: "Auto-redeemer",
  conditionalOrders: "Conditional orders",
  referralRegistry: "Referral registry",
  merkleDistributor: "Rewards distributor",
  impliedProbabilityOracle: "Implied-probability oracle",
  priceAdapterFactory: "Price adapter factory",
  kuruFeedFactory: "Kuru limiter feed factory",
  templateTimelock: "Template timelock",
};

const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

type Item = { label: string; address: Address };

const items = (pairs: readonly (readonly [string, unknown])[]): Item[] =>
  pairs.flatMap(([label, address]) => (isAddress(address) ? [{ label, address }] : []));

/** "Hunch order book", "Kuru v1" or "Kuru v2": the venue in a group title. */
const venueTitle = (st: Stack): string =>
  st.venue === "hunch" ? "Hunch order book" : st.kuruVersion === 2 ? "Kuru v2" : "Kuru v1";

/**
 * The contracts a stack's books live on: Hunch Book's own book factory, margin account and book
 * implementation, or Kuru's router and margin account (v1) or SpotRouter, AccountCore and
 * WithdrawalLimiter (v2).
 */
export function venueItems(d: Deployment, st: Stack): Item[] {
  const venue = st.contracts.venue;
  if (venue?.kind === "hunch") {
    return items([
      ["Order book factory", venue.bookFactory],
      ["Margin account", venue.marginAccount],
      ["Order book implementation", venue.bookImplementation],
    ]);
  }
  if (st.kuruVersion === 2) {
    const v2 = d.external.kuruV2;
    return items([
      ["Kuru v2 SpotRouter", v2?.spotRouter],
      ["Kuru v2 AccountCore", v2?.accountCore],
      ["Kuru v2 WithdrawalLimiter", v2?.withdrawalLimiter],
    ]);
  }
  return items([
    ["Kuru router", d.external.kuru.router],
    ["Kuru margin account", d.external.kuru.marginAccount],
  ]);
}

/**
 * Every address in deployments/<network>.json, grouped: each stack with the contracts its books live
 * on (the stack new markets go to says so), the primary stack's resolvers and periphery, our wallets,
 * and the outside contracts the resolvers read.
 */
export function contractGroups(d: Deployment): ContractGroup[] {
  const h = d.hunchBook;
  const all = stacksOf(d);
  const fresh = all.length > 1 ? defaultStackOf(d)?.name : undefined;
  const title = (st: Stack): string => {
    const tags = [venueTitle(st), ...(st.name === fresh ? ["new markets"] : [])].join(", ");
    return st.primary ? `Hunch Book core: primary stack (${tags})` : `Stack ${st.name} (${tags})`;
  };
  const primaryResolvers = new Set(
    Object.values(h.resolvers ?? {}).flatMap((a) => (isAddress(a) ? [a.toLowerCase()] : [])),
  );
  const stackGroups = all.map((st): ContractGroup => {
    const c = st.contracts;
    // An extra stack lists the resolvers it does not share with the primary one (a parlay resolver is
    // tied to its own factory), and its own periphery.
    const ownResolvers = st.primary
      ? []
      : Object.entries(c.resolvers ?? {}).flatMap(([key, address]) =>
          isAddress(address) && !primaryResolvers.has(address.toLowerCase())
            ? [{ label: RESOLVER_LABEL[key] ?? key, address }]
            : [],
        );
    const ownPeriphery = st.primary
      ? []
      : items(
          Object.entries(c.periphery ?? {}).flatMap(([key, address]) =>
            PERIPHERY_LABEL[key] ? [[PERIPHERY_LABEL[key] as string, address] as const] : [],
          ),
        );
    return {
      title: title(st),
      items: [
        ...items([
          ["Factory", c.factory],
          ["Collateral vault", c.vault],
          ...(st.primary ? ([["Market implementation", c.marketImplementation]] as const) : []),
          ["Graduator", c.graduator],
          ["Router", c.router],
          ...(st.primary ? ([["USDC", c.usdc ?? d.external.usdc]] as const) : []),
        ]),
        ...venueItems(d, st),
        ...ownResolvers,
        ...ownPeriphery,
      ],
    };
  });
  const resolvers = Object.entries(h.resolvers ?? {}).flatMap(([key, address]) =>
    isAddress(address) ? [{ label: RESOLVER_LABEL[key] ?? key, address }] : [],
  );
  const periphery = Object.entries(h.periphery ?? {}).flatMap(([key, address]) =>
    PERIPHERY_LABEL[key] && isAddress(address) ? [{ label: PERIPHERY_LABEL[key] as string, address }] : [],
  );
  const ours = items([
    ["Keeper (ours)", d.wallets.keeper],
    ["Maker bot (ours)", d.wallets.maker],
    ["Guardian", h.guardian],
    ["Fee recipient", h.feeRecipient],
  ]);
  const external = [
    { label: "Perpl Exchange", address: d.external.perpl.exchange },
    { label: "Pyth", address: d.external.pyth.contract },
    ...Object.entries(d.external.chainlink).map(([pair, address]) => ({
      label: `Chainlink ${pair}`,
      address,
    })),
  ].filter((x) => isAddress(x.address));
  const [primary, ...extra] = stackGroups;
  return [
    ...(primary ? [primary] : []),
    { title: "Resolvers", items: resolvers },
    { title: "Periphery", items: periphery },
    ...extra,
    { title: "Our wallets and roles", items: ours },
    { title: "Outside contracts the resolvers read", items: external },
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
