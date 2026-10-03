import { addressUrl, CREATOR_SHARE_BPS, deployments, type GraduationRule, Phase } from "@hunch-book/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { isSeededByUs, type LandingRead } from "@/lib/chain/landing";
import { appDeployment, appNetwork, appNetworkLabel, factoryOf, isDeployed, REPO_URL } from "@/lib/config";
import { formatBpsPercent, formatFixed, formatInt, formatUsdc, shortAddress } from "@/lib/format";
import {
  chanceDisplay,
  lifecycleStages,
  marketChance,
  phaseLabel,
  phaseTone,
  STAGES,
} from "@/lib/market/logic";
import { fallbackHeadline } from "@/lib/market/params";
import type { MarketView } from "@/lib/market/types";
import { AddressLink, Badge, ButtonLink } from "../ui";
import s from "./landing.module.css";

export const PROTOCOL_URL = `${REPO_URL}/blob/main/docs/PROTOCOL.md`;
const DEPLOYMENTS_URL = `${REPO_URL}/blob/main/deployments/${appNetwork}.json`;

function SectionLabel({ index, children }: { index: string; children: ReactNode }) {
  return (
    <p className={s.label}>
      <span className={s.labelIndex}>{index}</span>
      <span>{children}</span>
    </p>
  );
}

/** "500 USDC", without trailing zeros, for prose. */
const usdcWords = (base: bigint): string => `${formatFixed(base, 6, { maxDecimals: 2 })} USDC`;

/** The graduation rule in words, from the chain. */
export function ruleWords(rule: GraduationRule): string {
  return `at least ${usdcWords(rule.minPool)} from at least ${formatInt(rule.minStakers)} wallets, with a chance between ${formatBpsPercent(rule.minChanceBps)} and ${formatBpsPercent(rule.maxChanceBps)}`;
}

/** "0.40 seconds" from a measured block time. */
export function blockTimeWords(msPerBlock: number): string {
  return `${(msPerBlock / 1000).toFixed(2)} seconds`;
}

// ---------- 1. hero ----------

/** The track Pool, Graduate, Trade, Settle with the market's position on it. */
export function StageTrack({ m }: { m: Pick<MarketView, "phase" | "graduated"> }) {
  const states = lifecycleStages(m);
  return (
    <ol className={s.track} aria-label="Where this market is">
      {STAGES.map((name, i) => {
        const state = states[i] ?? "todo";
        return (
          <li key={name} className={`${s.trackStep} ${s[`track-${state}`] ?? ""}`}>
            <span className={s.trackDot} aria-hidden="true" />
            <span className={s.trackName}>{name}</span>
            <span className="visually-hidden">
              {state === "done"
                ? " (done)"
                : state === "current"
                  ? " (now)"
                  : state === "skipped"
                    ? " (skipped)"
                    : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The newest market, live, as the hero's picture. Falls back to the contract links. */
export function HeroCard({ live }: { live: LandingRead }) {
  const m = live.status === "ok" ? live.data.newest : null;
  if (!m) {
    return (
      <aside className={s.heroCard} aria-label="Contracts">
        <div className={s.heroCardBar}>
          <span className={s.liveDot}>{appNetworkLabel}</span>
        </div>
        <div className={s.heroCardBody}>
          <p className={s.heroCardTitle}>
            {live.status === "ok"
              ? "No markets yet. The first one appears here as soon as it is created."
              : live.status === "not-deployed"
                ? `Contracts are not deployed on ${appNetworkLabel} yet.`
                : `Live figures are unavailable right now. The contracts are on ${appNetworkLabel}.`}
          </p>
          <StageTrack m={{ phase: Phase.Pool, graduated: false }} />
        </div>
        <ContractLinks />
      </aside>
    );
  }
  const chance = chanceDisplay(marketChance(m));
  const seeded = isSeededByUs(appDeployment, m.creator);
  return (
    <aside className={s.heroCard} aria-label="Newest market, live">
      <div className={s.heroCardBar}>
        <span className={s.liveDot}>
          {appNetworkLabel} · market #{m.marketId.toString()}
        </span>
        {seeded ? <span className={s.heroCardTag}>Seeded by Hunch Book</span> : null}
      </div>
      <div className={s.heroCardBody}>
        <p className={s.heroCardTitle}>
          <Link href={`/m/${m.address}`}>{m.description ?? fallbackHeadline(appDeployment, m.decoded)}</Link>
        </p>
        <StageTrack m={m} />
        <div className={s.heroFigures}>
          <Figure label={m.graduated ? "USDC pool at graduation" : "USDC in the pool"}>
            {formatUsdc(m.pool.total)}
          </Figure>
          <Figure label="stakers">{formatInt(m.pool.stakers)}</Figure>
          <Figure label={chance.caption}>{chance.value}</Figure>
        </div>
      </div>
      <div className={s.heroCardFoot}>
        {m.book ? (
          <span>
            Kuru book <AddressLink address={m.book} />
          </span>
        ) : (
          <span className="subtle">No Kuru book yet</span>
        )}
        <Link href={`/m/${m.address}`}>Open market</Link>
      </div>
    </aside>
  );
}

export function Hero({ live }: { live: LandingRead }) {
  const deployed = isDeployed(appDeployment);
  const mainnetLive = isDeployed(deployments["monad-mainnet"]);
  return (
    <section className={s.hero} aria-labelledby="hero-title">
      <div className={`${s.wrap} ${s.heroGrid}`}>
        <div>
          <div className={s.badges}>
            <Badge tone={deployed ? "accent" : "muted"} dot>
              {deployed ? `Live on ${appNetworkLabel}` : `${appNetworkLabel}: not deployed yet`}
            </Badge>
            {appNetwork === "monad-testnet" ? (
              <Badge tone="muted">{mainnetLive ? "Live on Monad mainnet" : "Mainnet planned"}</Badge>
            ) : null}
          </div>
          <h1 className={s.h1} id="hero-title">
            Prediction markets that start as pools and graduate to an <em>onchain order book</em>.
          </h1>
          <p className={s.heroSub}>
            Back YES or NO with USDC from the first dollar, sell before the answer once the market graduates
            to Kuru, and get paid by a contract that reads the outcome from the chain. No one decides it by
            hand.
          </p>
          <div className={s.ctas}>
            <ButtonLink href="/markets" variant="primary" className={s.cta}>
              Open markets
            </ButtonLink>
            <ButtonLink href={PROTOCOL_URL} external className={s.cta}>
              Read the protocol
            </ButtonLink>
          </div>
        </div>
        <HeroCard live={live} />
      </div>
    </section>
  );
}

// ---------- 2. lifecycle ----------

interface Step {
  title: string;
  body: string;
  facts: string[];
  status: "live" | "building";
}

export function lifecycleSteps(rule: GraduationRule | null): Step[] {
  return [
    {
      title: "Pool",
      body: "Stake USDC on YES or NO. The split of the pool is the market's chance, so it works from the first dollar with no market maker.",
      facts: ["chance = YES stakes / pool", "stakes stay in until settlement"],
      status: "live",
    },
    {
      title: "Graduate",
      body: rule
        ? `When the pool holds ${ruleWords(rule)}, one transaction turns it into fully backed YES and NO tokens. Each staker's payout stays the same.`
        : "When the pool meets its graduation rule, one transaction turns it into fully backed YES and NO tokens. Each staker's payout stays the same.",
      facts: rule
        ? [
            `pool ≥ ${usdcWords(rule.minPool)}`,
            `stakers ≥ ${formatInt(rule.minStakers)}`,
            `chance ${formatBpsPercent(rule.minChanceBps)} to ${formatBpsPercent(rule.maxChanceBps)}`,
          ]
        : ["rule read from the factory"],
      status: "live",
    },
    {
      title: "Trade on Kuru",
      body: "YES opens on its own Kuru order book at the pool's price. Buy or sell YES or NO at any time, each in one transaction.",
      facts: ["1 YES + 1 NO = 1 USDC", "sell before the answer"],
      status: "building",
    },
    {
      title: "Settle from the chain",
      body: "After the window closes, anyone can settle. The resolver reads Perpl's funding history or a Chainlink price, and winning tokens pay out in USDC.",
      facts: ["no one sets the outcome", "void if the source never answers"],
      status: "building",
    },
  ];
}

export function Lifecycle({ rule }: { rule: GraduationRule | null }) {
  return (
    <section className={s.section} aria-labelledby="how-title">
      <div className={s.wrap}>
        <SectionLabel index="01">How it works</SectionLabel>
        <h2 className={s.h2} id="how-title">
          A market starts as a pool and grows into a book
        </h2>
        <p className={s.lede}>
          Pools need no market maker, so a new question works from its first stake. Once people show up, the
          market graduates into an order book you can trade in and out of.
        </p>
        <ol className={s.flow}>
          {lifecycleSteps(rule).map((step, i) => (
            <li className={s.step} key={step.title}>
              <div className={s.stepHead}>
                <span className={s.stepIndex}>{`0${i + 1}`}</span>
                <Badge tone={step.status === "live" ? "accent" : "warn"}>
                  {step.status === "live" ? "Live on testnet" : "Building"}
                </Badge>
              </div>
              <h3 className={s.stepTitle}>{step.title}</h3>
              <p className={s.stepBody}>{step.body}</p>
              <ul className={s.facts}>
                {step.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------- 3. who it's for ----------

export function ForTraders() {
  const creatorShare = formatBpsPercent(CREATOR_SHARE_BPS);
  return (
    <section className={s.section} aria-labelledby="who-title">
      <div className={`${s.wrap} ${s.split}`}>
        <div>
          <SectionLabel index="02">Who it's for</SectionLabel>
          <h2 className={s.h2} id="who-title">
            The Perpl trader who pays funding
          </h2>
          <p className={s.lede}>
            You hold a long on Perpl and pay funding every hour. You want some of it back if funding stays
            high this week, and you want to drop that cover the moment it cools.
          </p>
          <p className={s.aside}>
            Also for anyone with a view on a price or on funding, and for creators, who earn {creatorShare} of
            the fee on markets they start.
          </p>
        </div>
        <ol className={s.story} aria-label="Example">
          <li className={s.storyItem}>
            <span className={s.storyWhen}>Monday</span>
            <p className={s.storyText}>
              Buy YES on a market like{" "}
              <strong>"Will MON longs pay more than a set amount in funding on Perpl this week?"</strong>
            </p>
          </li>
          <li className={s.storyItem}>
            <span className={s.storyWhen}>Funding stays high</span>
            <p className={s.storyText}>
              YES wins at settlement. Each token pays 1 USDC, less a small fixed fee, which offsets the
              funding you paid.
            </p>
          </li>
          <li className={s.storyItem}>
            <span className={s.storyWhen}>It cools early</span>
            <p className={s.storyText}>
              Sell your YES on the Kuru book whenever you like. You get what it is worth that day, not what it
              might be on Sunday.
            </p>
          </li>
        </ol>
      </div>
    </section>
  );
}

// ---------- 4. live proof ----------

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.figure}>
      <span className={s.figureValue}>{children}</span>
      <span className={s.figureLabel}>{label}</span>
    </div>
  );
}

export function SeededNote({ m }: { m: MarketView }) {
  if (!isSeededByUs(appDeployment, m.creator)) return null;
  return (
    <p className={s.seeded}>
      <strong>Seeded by Hunch Book.</strong>{" "}
      {m.graduated
        ? "We created this market and filled its pool from our own wallets to meet the graduation rule. That activity is ours, not outside demand."
        : "We created this market from our own wallet and made its first stake. Stakes from our wallets are ours, not outside demand."}
    </p>
  );
}

export function NewestMarket({ m }: { m: MarketView }) {
  const chance = chanceDisplay(marketChance(m));
  const seeded = isSeededByUs(appDeployment, m.creator);
  return (
    <div className={s.market}>
      <div className={s.marketMeta}>
        <span>Newest market</span>
        <span className="mono">#{m.marketId.toString()}</span>
        <Badge tone={phaseTone(m.phase)} dot>
          {phaseLabel(m.phase)}
        </Badge>
        {seeded ? <Badge tone="warn">Seeded by Hunch Book</Badge> : null}
      </div>
      <h3 className={s.marketTitle}>
        <Link href={`/m/${m.address}`}>{m.description ?? fallbackHeadline(appDeployment, m.decoded)}</Link>
      </h3>
      <div className={s.figures}>
        <Figure label={chance.caption}>{chance.value}</Figure>
        <Figure label={m.graduated ? "USDC pool at graduation" : "USDC in the pool"}>
          {formatUsdc(m.pool.total)}
        </Figure>
        <Figure label="stakers">{formatInt(m.pool.stakers)}</Figure>
        <Figure label="Kuru book">
          {m.book ? <AddressLink address={m.book} /> : <span className="subtle">none yet</span>}
        </Figure>
      </div>
      <SeededNote m={m} />
      <p>
        <Link href={`/m/${m.address}`}>Open this market</Link>
      </p>
    </div>
  );
}

function ContractLinks() {
  const factory = factoryOf(appDeployment);
  const vault = appDeployment.hunchBook.vault;
  return (
    <div className={s.links}>
      {factory ? (
        <a href={addressUrl(appDeployment, factory)} target="_blank" rel="noreferrer">
          Factory <span className="mono">{shortAddress(factory)}</span>
        </a>
      ) : null}
      {vault ? (
        <a href={addressUrl(appDeployment, vault)} target="_blank" rel="noreferrer">
          Vault <span className="mono">{shortAddress(vault)}</span>
        </a>
      ) : null}
      <a href={DEPLOYMENTS_URL} target="_blank" rel="noreferrer">
        Every address and deploy transaction
      </a>
    </div>
  );
}

export function LiveProof({ live }: { live: LandingRead }) {
  const testnet = appNetwork === "monad-testnet";
  return (
    <section className={s.section} aria-labelledby="live-title">
      <div className={s.wrap}>
        <SectionLabel index="03">Live now</SectionLabel>
        <h2 className={s.h2} id="live-title">
          Read from the chain, not from us
        </h2>
        <p className={s.lede}>
          These figures come straight from the contracts on {appNetworkLabel} each time this page refreshes,
          about every 30 seconds.
        </p>
        <div className={s.proof} style={{ marginTop: 32 }}>
          <div className={s.proofBar}>
            <span className={s.liveDot}>
              {live.status === "not-deployed" ? "Not deployed" : appNetworkLabel}
            </span>
            {live.status === "ok" && live.data.block !== null ? (
              <span>Read at block {formatInt(live.data.block)}</span>
            ) : null}
          </div>
          {live.status === "ok" ? (
            <div className={s.proofGrid}>
              <div className={s.proofStats}>
                <div>
                  <p className={s.bigNumber}>{formatInt(live.data.marketCount)}</p>
                  <p className={s.statLabel}>
                    {live.data.marketCount === 1 ? "market created" : "markets created"} (factory.marketCount)
                  </p>
                </div>
                {live.data.msPerBlock !== null ? (
                  <div>
                    <p className={s.bigNumber}>{(live.data.msPerBlock / 1000).toFixed(2)}s</p>
                    <p className={s.statLabel}>average block time over the last 10,000 blocks</p>
                  </div>
                ) : null}
              </div>
              {live.data.newest ? (
                <NewestMarket m={live.data.newest} />
              ) : (
                <div className={s.market}>
                  <p className={s.marketTitle}>No markets yet.</p>
                  <p className="muted">The first market appears here as soon as someone creates one.</p>
                </div>
              )}
            </div>
          ) : (
            <div className={s.market}>
              <p className={s.marketTitle}>
                {live.status === "not-deployed"
                  ? `The contracts are not deployed on ${appNetworkLabel} yet.`
                  : `Could not reach ${appNetworkLabel} just now.`}
              </p>
              <p className="muted">
                {live.status === "not-deployed"
                  ? "This panel fills in from the chain once they are."
                  : "Nothing here is cached or estimated, so the figures stay hidden until the next read succeeds."}
              </p>
            </div>
          )}
          <ContractLinks />
          {testnet ? (
            <p className={s.testnetNote}>
              Testnet: stakes use Hunch Book's own test USDC, not real money. Mainnet is planned.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ---------- 5. why it holds up ----------

export function HoldsUp() {
  const vault = appDeployment.hunchBook.vault;
  const points: { title: string; body: ReactNode }[] = [
    {
      title: "Every pair is backed by 1 USDC",
      body: (
        <>
          Until settlement, each YES token and its NO token are backed by exactly 1 USDC held in the{" "}
          {vault ? (
            <a href={addressUrl(appDeployment, vault)} target="_blank" rel="noreferrer">
              vault
            </a>
          ) : (
            "vault"
          )}
          . The vault checks that it is solvent after every call.
        </>
      ),
    },
    {
      title: "No one sets the answer",
      body: "No address, including ours, can set an outcome. A resolver contract reads it from Perpl's funding history or a Chainlink price.",
    },
    {
      title: "Our guardian can only pause the front door",
      body: "The guardian can pause new markets and graduation. It can never pause settlement, redemption or refunds, and it can never move your funds.",
    },
    {
      title: "Open source and tested",
      body: (
        <>
          Every contract is public, with unit, fuzz, invariant and fork tests against live Monad contracts.{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Read the code
          </a>
          .
        </>
      ),
    },
  ];
  return (
    <section className={s.section} aria-labelledby="holds-title">
      <div className={s.wrap}>
        <SectionLabel index="04">Why it holds up</SectionLabel>
        <h2 className={s.h2} id="holds-title">
          Built so your money does not depend on trusting us
        </h2>
        <ul className={s.cards}>
          {points.map((p, i) => (
            <li className={s.card} key={p.title}>
              <span className={s.cardIndex}>{`0${i + 1}`}</span>
              <h3 className={s.cardTitle}>{p.title}</h3>
              <p className={s.cardBody}>{p.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------- 6. why Monad ----------

export function WhyMonad({ msPerBlock }: { msPerBlock: number | null }) {
  const points = [
    {
      title: "Kuru: an order book that lives onchain",
      body: "A pool graduates into a real YES/USDC book that anyone can quote, not into a matching engine on our server.",
    },
    {
      title: "Perpl: funding history you can read by block",
      body: "Perpl stores cumulative funding onchain, so a market settles from it with no oracle committee and no keeper of ours deciding.",
    },
    {
      title: "Fast, cheap blocks",
      body:
        msPerBlock !== null
          ? `A block every ${blockTimeWords(msPerBlock)} on average, measured on chain just now, and low fees make a separate order book for each small market affordable.`
          : "Fast blocks and low fees make a separate order book for each small market affordable.",
    },
  ];
  return (
    <section className={s.section} aria-labelledby="monad-title">
      <div className={s.wrap}>
        <SectionLabel index="05">Why Monad</SectionLabel>
        <h2 className={s.h2} id="monad-title">
          It only works where the book and the data are both onchain
        </h2>
        <ul className={`${s.cards} ${s.cards3}`}>
          {points.map((p) => (
            <li className={s.card} key={p.title}>
              <h3 className={s.cardTitle}>{p.title}</h3>
              <p className={s.cardBody}>{p.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------- closing ----------

export function Closing() {
  return (
    <section className={s.closingSection} aria-labelledby="closing-title">
      <div className={s.wrap}>
        <div className={s.closing}>
          <h2 className={s.closingTitle} id="closing-title">
            See the markets on {appNetworkLabel}, or read exactly how they work.
          </h2>
          <div className={s.ctas} style={{ marginTop: 0 }}>
            <ButtonLink href="/markets" variant="primary" className={s.cta}>
              Open markets
            </ButtonLink>
            <ButtonLink href={PROTOCOL_URL} external className={s.cta}>
              Read the protocol
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- page ----------

export function Landing({ live }: { live: LandingRead }) {
  const data = live.status === "ok" ? live.data : null;
  return (
    <>
      <Hero live={live} />
      <Lifecycle rule={data?.rule ?? data?.newest?.rule ?? null} />
      <ForTraders />
      <LiveProof live={live} />
      <HoldsUp />
      <WhyMonad msPerBlock={data?.msPerBlock ?? null} />
      <Closing />
    </>
  );
}
