import { addressUrl, type Deployment, defaultStackOf, deployments, stacksOf } from "@hunch-book/shared";
import type { ReactNode } from "react";
import { appDeployment, appNetworkLabel, isDeployed, REPO_URL } from "@/lib/config";
import { Badge, ButtonLink } from "../ui";
import s from "./landing.module.css";

// Kuru is the venue for every new market. This section says so near the top of the page, with each
// Kuru path's status read from deployments/<network>.json (CLAUDE.md Rule 4: planned, building, live).

export const KURU_URL = "https://www.kuru.io";

/** The mainnet launch, rehearsed on a fork with a book created as Kuru's owner. */
const MAINNET_REHEARSAL = `${REPO_URL}/blob/main/contracts/test/fork/MainnetRehearsal.fork.t.sol`;

export interface KuruCard {
  key: "v1" | "v2" | "mainnet";
  title: string;
  status: "live" | "building" | "planned";
  /** The badge: the status word, with the network or what it waits on. */
  badge: string;
  body: string;
  facts: ReactNode[];
}

/** Kuru v1, Kuru v2 and mainnet, each with the status the deployments files give it. */
export function kuruCards(
  deployment: Deployment = appDeployment,
  mainnet: Deployment = deployments["monad-mainnet"],
  networkLabel: string = appNetworkLabel,
): KuruCard[] {
  const stacks = stacksOf(deployment);
  const v1 = stacks.find((st) => st.venue === "kuru" && st.kuruVersion === 1);
  const v2 = stacks.find((st) => st.venue === "kuru" && st.kuruVersion === 2);
  const v1Graduator = v1?.contracts.graduator;
  const v1Live = Boolean(v1Graduator && v1?.contracts.router);
  const v2Factory = v2?.contracts.factory;
  const v2Built = Boolean(v2?.contracts.graduator && v2Factory);
  const v1TakesNew = v1 !== undefined && defaultStackOf(deployment)?.name === v1.name;
  const mainnetLive = isDeployed(mainnet);
  return [
    {
      key: "v1",
      title: "Kuru v1",
      status: v1Live ? "live" : "planned",
      badge: v1Live ? `Live on ${networkLabel}` : "Planned",
      body: `${v1TakesNew ? "New markets go here. " : ""}Where Kuru lets anyone create books, as on testnet, the graduation transaction creates the market's YES/USDC book through Kuru's deployProxy. Our open-source maker bot quotes both sides.`,
      facts: [
        "one book per market",
        "YES and NO on one book",
        v1Live && v1Graduator ? (
          <a key="graduator" href={addressUrl(deployment, v1Graduator)} target="_blank" rel="noreferrer">
            graduator
          </a>
        ) : null,
      ].filter(Boolean),
    },
    {
      key: "v2",
      title: "Kuru v2",
      status: v2Built ? "building" : "planned",
      badge: v2Built ? "Building: waits on Kuru" : "Planned",
      body: "Only Kuru's governance creates v2 books, after it sets up each token. Pools on the v2 stack fill to their rule and wait for their books, and our keeper publishes each request. A pool whose book never arrives settles as a pool.",
      facts: [
        v2Built && v2Factory ? (
          <a key="factory" href={addressUrl(deployment, v2Factory)} target="_blank" rel="noreferrer">
            v2 factory
          </a>
        ) : null,
        v2Built ? (
          <a key="requests" href="/api/v1/kuru/requests">
            book requests
          </a>
        ) : null,
      ].filter(Boolean),
    },
    {
      key: "mainnet",
      title: "Monad mainnet",
      status: mainnetLive ? "live" : "planned",
      badge: mainnetLive ? "Contracts live" : "Planned",
      body: "The Kuru stack, with Circle USDC. Only Kuru's owner can create books there, so Kuru creates each YES/USDC book and anyone registers it with the Graduator, which checks it first. Until then a market stays a pool.",
      facts: [
        "Kuru creates each book",
        <a key="rehearsal" href={MAINNET_REHEARSAL} target="_blank" rel="noreferrer">
          rehearsed on a mainnet fork
        </a>,
      ],
    },
  ];
}

export function OnKuru() {
  return (
    <section className={s.section} id="kuru" aria-labelledby="kuru-title">
      <div className={s.wrap}>
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>
            <span className={s.eyebrowMark} aria-hidden="true" />
            Built on Kuru
          </p>
          <h2 className={s.h2} id="kuru-title">
            New markets graduate to Kuru's onchain order book
          </h2>
          <p className={s.lede}>
            Kuru is Monad's onchain order book. When a pool graduates, its YES token gets its own YES/USDC
            book on Kuru, opened with holders and the pool's split as its starting chance. NO trades through
            the same book: the router mints or merges a pair around each trade.
          </p>
        </div>
        <ol className={s.stages}>
          {kuruCards().map((card) => (
            <li className={s.stage} key={card.key}>
              <div className={s.stageHead}>
                <h3 className={s.stageTitle}>{card.title}</h3>
                <Badge tone={card.status === "live" ? "accent" : "warn"} dot>
                  {card.badge}
                </Badge>
              </div>
              <p className={s.stageBody}>{card.body}</p>
              {card.facts.length > 0 ? (
                <ul className={s.facts}>
                  {card.facts.map((fact, j) => (
                    // Facts are short fixed strings or links; their order never changes.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static list
                    <li key={j}>{fact}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
        <div className={s.ctas}>
          <ButtonLink href="/kuru" variant="primary" arrow>
            Kuru markets
          </ButtonLink>
          <ButtonLink href={KURU_URL} external>
            Visit Kuru
          </ButtonLink>
        </div>
        <p className={s.kuruNote}>Every pool, quote and trade by our wallets is labelled as ours.</p>
      </div>
    </section>
  );
}
