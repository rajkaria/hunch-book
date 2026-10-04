import { addressUrl, deployments, Phase } from "@hunch-book/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { isSeededByUs, type LandingRead } from "@/lib/chain/landing";
import { appDeployment, appNetwork, appNetworkLabel, factoryOf, isDeployed, REPO_URL } from "@/lib/config";
import { formatInt, formatUsdc, shortAddress } from "@/lib/format";
import { chanceDisplay, lifecycleStages, marketChance, type StageState } from "@/lib/market/logic";
import { fallbackHeadline } from "@/lib/market/params";
import type { MarketView } from "@/lib/market/types";
import { AddressLink, Badge, ButtonLink, ChanceBar, LiveDot, PhasePill } from "../ui";
import s from "./landing.module.css";
import { priceWords, usdcWords } from "./words";

const DEPLOYMENTS_URL = `${REPO_URL}/blob/main/deployments/${appNetwork}.json`;

// ---------- stage track ----------

/** The three stages the page explains, and which step of the four-step lifecycle each one reads. */
const TRACK: { name: string; step: number }[] = [
  { name: "Pool", step: 0 },
  { name: "Book", step: 2 },
  { name: "Settle", step: 3 },
];

const STATE_WORDS: Record<StageState, string> = {
  done: " (done)",
  current: " (now)",
  skipped: " (skipped)",
  todo: "",
};

/** Pool, Book, Settle, with the market's position on it. A pool that never graduated skips the book. */
export function StageTrack({ m }: { m: Pick<MarketView, "phase" | "graduated"> }) {
  const states = lifecycleStages(m);
  return (
    <ol className={s.track} aria-label="Where this market is">
      {TRACK.map(({ name, step }) => {
        const state = states[step] ?? "todo";
        return (
          <li key={name} className={`${s.trackStep} ${s[`track-${state}`] ?? ""}`}>
            <span className={s.trackDot} aria-hidden="true" />
            <span className={s.trackName}>{name}</span>
            <span className="visually-hidden">{STATE_WORDS[state]}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- contract links ----------

export function ContractLinks() {
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

// ---------- hero card ----------

function Figure({ label, unit, children }: { label: string; unit?: string; children: ReactNode }) {
  return (
    <div className={s.figure}>
      <dt className={s.figureLabel}>{label}</dt>
      <dd className={s.figureValue}>
        {children}
        {unit ? <span className={s.figureUnit}> {unit}</span> : null}
      </dd>
    </div>
  );
}

/** What we say about a market our own wallets created, everywhere it is shown. */
export function seededWords(m: Pick<MarketView, "graduated">): string {
  return m.graduated
    ? "We created this market and filled its pool from our own wallets to meet the graduation rule. That activity is ours, not outside demand."
    : "We created this market from our own wallet and made its first stake. Stakes from our wallets are ours, not outside demand.";
}

function CardShell({ label, children, top }: { label: string; children: ReactNode; top?: ReactNode }) {
  return (
    <div className={s.cardStage}>
      <div className={s.cardGlow} aria-hidden="true" />
      <aside className={s.heroCard} aria-label={label}>
        <div className={s.cardTop}>
          <span className={s.cardLive}>
            <LiveDot />
            {isDeployed(appDeployment) ? `Live on ${appNetworkLabel}` : appNetworkLabel}
          </span>
          {top}
        </div>
        {children}
      </aside>
    </div>
  );
}

function LiveMarketCard({ m }: { m: MarketView }) {
  const chance = marketChance(m);
  const shown = chanceDisplay(chance);
  const seeded = isSeededByUs(appDeployment, m.creator);
  const headline = m.description ?? fallbackHeadline(appDeployment, m.decoded);
  const href = `/m/${m.address}`;
  return (
    <CardShell
      label="Most active market, live"
      top={<span className="mono">Market #{m.marketId.toString()}</span>}
    >
      <div className={s.cardBadges}>
        <PhasePill phase={m.phase} outcome={m.outcome} />
        {seeded ? <Badge tone="warn">Seeded by Hunch Book</Badge> : null}
      </div>
      <p className={s.cardTitle}>
        <Link href={href}>{headline}</Link>
      </p>
      <div className={s.cardChance}>
        <span className={s.cardChanceValue}>{shown.value}</span>
        <span className={s.cardChanceCaption}>
          {shown.caption}
          {chance.source === "book" || chance.source === "pool" ? (
            <span className={s.cardChanceSource}>{chance.note}</span>
          ) : null}
        </span>
      </div>
      <ChanceBar bps={chance.bps} showLabels size="lg" />
      <dl className={s.cardFigures}>
        {m.graduated ? (
          <>
            <Figure label="Best bid" unit={m.quote?.bid ? "USDC" : undefined}>
              {m.quote?.bid ? priceWords(m.quote.bid) : "none"}
            </Figure>
            <Figure label="Best ask" unit={m.quote?.ask ? "USDC" : undefined}>
              {m.quote?.ask ? priceWords(m.quote.ask) : "none"}
            </Figure>
            <Figure label="Pool at graduation" unit="USDC">
              {formatUsdc(m.pool.total)}
            </Figure>
            <Figure label="Stakers">{formatInt(m.pool.stakers)}</Figure>
          </>
        ) : (
          <>
            <Figure label="YES pool" unit="USDC">
              {formatUsdc(m.pool.yes)}
            </Figure>
            <Figure label="NO pool" unit="USDC">
              {formatUsdc(m.pool.no)}
            </Figure>
            <Figure label="Stakers">{formatInt(m.pool.stakers)}</Figure>
            <Figure label="Graduates at">{usdcWords(m.rule.minPool)}</Figure>
          </>
        )}
      </dl>
      <StageTrack m={m} />
      {seeded ? <p className={s.cardNote}>{seededWords(m)}</p> : null}
      <div className={s.cardFoot}>
        {m.book ? (
          <span className={s.cardBook}>
            Kuru book <AddressLink address={m.book} />
          </span>
        ) : (
          <span className="subtle">No Kuru book yet</span>
        )}
        <Link href={href} className={s.cardOpen}>
          Open market <span aria-hidden="true">→</span>
        </Link>
      </div>
    </CardShell>
  );
}

/** The most active market, live, as the hero's picture. Falls back to plain words and contract links. */
export function HeroCard({ live }: { live: LandingRead }) {
  const m = live.status === "ok" ? live.data.featured : null;
  if (m) return <LiveMarketCard m={m} />;
  const empty = live.status === "ok" && live.data.marketCount === 0;
  return (
    <CardShell label="Contracts">
      <p className={s.cardTitle}>
        {empty
          ? "No markets yet. The first one appears here as soon as it is created."
          : live.status === "ok"
            ? "Could not read the markets just now. They load again on the next refresh."
            : live.status === "not-deployed"
              ? `Contracts are not deployed on ${appNetworkLabel} yet.`
              : `Live figures are unavailable right now. The contracts are on ${appNetworkLabel}.`}
      </p>
      <ChanceBar bps={null} size="lg" label="No market to show yet" />
      <StageTrack m={{ phase: Phase.Pool, graduated: false }} />
      {empty ? (
        <ButtonLink href="/create" variant="primary" block arrow>
          Start the first market
        </ButtonLink>
      ) : null}
      <ContractLinks />
    </CardShell>
  );
}

// ---------- hero ----------

export function Hero({ live }: { live: LandingRead }) {
  const deployed = isDeployed(appDeployment);
  const mainnetLive = isDeployed(deployments["monad-mainnet"]);
  return (
    <section className={s.hero} aria-labelledby="hero-title">
      <div className={`${s.wrap} ${s.heroGrid}`}>
        <div className={s.heroCopy}>
          <p className={`${s.eyebrow} rise-in`}>
            <span className={s.eyebrowMark} aria-hidden="true" />
            Prediction markets on Monad
          </p>
          <h1 className={`${s.h1} rise-in`} id="hero-title">
            <span className={s.h1Line}>Start as a pool.</span>{" "}
            <span className={s.h1Line}>
              Graduate to a <span className="highlight">book</span>.
            </span>{" "}
            <span className={s.h1Line}>Settle from the chain.</span>
          </h1>
          <p className={`${s.heroSub} rise-in-2`}>
            Stake USDC on YES or NO from the first dollar. When the pool fills, it becomes a real order book
            you can sell into, and a contract settles it by reading the chain.
          </p>
          <div className={`${s.ctas} rise-in-2`}>
            <ButtonLink href="/markets" variant="primary" size="lg" arrow>
              Browse markets
            </ButtonLink>
            <ButtonLink href="/create" size="lg">
              Start a market
            </ButtonLink>
          </div>
          <ul className={`${s.proofPoints} rise-in-3`}>
            <li>No one sets an outcome by hand</li>
            <li>1 YES + 1 NO is always backed by 1 USDC</li>
            <li>Open source, MIT</li>
          </ul>
          <div className={`${s.badges} rise-in-3`}>
            <Badge tone={deployed ? "accent" : "muted"} live={deployed} dot={!deployed}>
              {deployed ? `Live on ${appNetworkLabel}` : `${appNetworkLabel}: not deployed yet`}
            </Badge>
            {appNetwork === "monad-testnet" ? (
              <Badge tone="muted">{mainnetLive ? "Live on Monad mainnet" : "Mainnet planned"}</Badge>
            ) : null}
          </div>
        </div>
        <div className="rise-in-3">
          <HeroCard live={live} />
        </div>
      </div>
    </section>
  );
}
