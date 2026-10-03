import { Phase } from "@hunch-book/shared";
import type { ReactNode } from "react";
import { appDeployment } from "@/lib/config";
import { formatFixed, formatInt, formatUsdc, formatUtc } from "@/lib/format";
import { chanceDisplay, graduationProgress, marketChance, voidTerms, windowMoment } from "@/lib/market/logic";
import { describeSource, templateLabel } from "@/lib/market/params";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { AddressLink, ChanceBar, KeyValues, Panel, Progress, Stat } from "../ui";
import s from "./market.module.css";

const priceE18 = (p: bigint | null): string =>
  p === null ? "empty" : `${formatFixed(p, 18, { minDecimals: 3, maxDecimals: 3 })} USDC`;

export function ChancePanel({ m }: { m: MarketView }) {
  const chance = marketChance(m);
  const shown = chanceDisplay(chance);
  const onBook = m.phase === Phase.Graduated || m.phase === Phase.Closed;
  return (
    <Panel
      title="Implied chance"
      labelledBy="chance-title"
      aside={shown.caption === chance.note ? undefined : <span className="subtle">{chance.note}</span>}
    >
      <div className={s.chanceRow}>
        <span className={s.chanceBig}>{shown.value}</span>
        <span className={s.chanceCaption}>{shown.caption}</span>
      </div>
      <ChanceBar bps={chance.bps} />
      {onBook ? null : (
        <div className={s.split}>
          <span className={s.yesText}>YES {formatUsdc(m.pool.yes)} USDC</span>
          <span className={s.noText}>NO {formatUsdc(m.pool.no)} USDC</span>
        </div>
      )}
      {onBook ? (
        <div className={s.bookQuote}>
          <Stat label="Best bid (Kuru)" value={priceE18(m.quote?.bid ?? null)} />
          <Stat label="Best ask (Kuru)" value={priceE18(m.quote?.ask ?? null)} />
        </div>
      ) : null}
      <div className={s.stats}>
        <Stat
          label={m.graduated ? "Pool at graduation" : "Pool"}
          value={`${formatUsdc(m.pool.total)}`}
          hint="USDC"
        />
        <Stat label="Stakers" value={m.pool.stakers.toString()} />
        <Stat label="Pool cap" value={formatUsdc(m.caps.poolCap)} hint="USDC" />
        <Stat label="Min stake" value={formatUsdc(m.caps.minStake)} hint="USDC" />
      </div>
      {onBook ? (
        <p className={s.trust}>
          After graduation the chance is the mid price of the YES/USDC book on Kuru
          {m.book ? (
            <>
              {" "}
              (<AddressLink address={m.book} />)
            </>
          ) : null}
          . Book depth and trading arrive in the next build.
        </p>
      ) : null}
    </Panel>
  );
}

export function GraduationPanel({ m }: { m: MarketView }) {
  if (m.phase === Phase.PoolLocked) {
    return (
      <Panel title="Graduation" labelledBy="grad-title">
        <p className={s.prose}>
          This pool locked without graduating. It settles as a pool: winners are paid from it.
        </p>
      </Panel>
    );
  }
  if (m.phase !== Phase.Pool) return null;
  const rows = graduationProgress(m);
  return (
    <Panel
      title="Graduation rule"
      labelledBy="grad-title"
      aside={<span className={m.ruleMet ? s.met : "subtle"}>{m.ruleMet ? "Met" : "Not met yet"}</span>}
    >
      <ul className={s.rules}>
        {rows.map((r) => (
          <li className={s.rule} key={r.label}>
            <div className={s.ruleLine}>
              <span>{r.label}</span>
              <span className={`${s.ruleValue} ${r.met ? s.met : ""}`}>
                {r.current} / {r.target}
              </span>
            </div>
            {r.ratio !== null ? (
              <Progress ratio={r.ratio} met={r.met} label={`${r.label}: ${r.current} of ${r.target}`} />
            ) : null}
          </li>
        ))}
      </ul>
      <p className={s.trust}>
        When every line is met before lock, anyone can graduate the pool into fully backed YES and NO tokens
        on a Kuru order book. Each staker's payout stays exactly what the pool would have paid.
      </p>
    </Panel>
  );
}

interface Step {
  title: string;
  when: ReactNode;
  note: string;
  done: boolean;
}

export function TimelinePanel({
  m,
  clock,
  now,
}: {
  m: MarketView;
  clock: ChainClock | null;
  now: number | null;
}) {
  const point = (value: bigint): { when: ReactNode; done: boolean } => {
    if (!m.window.blockClock) {
      return { when: formatUtc(value), done: now !== null && now >= Number(value) };
    }
    const moment = windowMoment(m.window, value, clock);
    return {
      when: (
        <>
          Block {formatInt(value)}
          {moment ? <span className="muted"> (about {formatUtc(moment.time)})</span> : null}
        </>
      ),
      done: clock !== null && clock.blockNumber >= value,
    };
  };
  const lock = point(m.window.lock);
  const close = point(m.window.close);
  const steps: Step[] = [
    { title: "Lock", note: "Staking and graduation stop.", ...lock },
    { title: "Close", note: "The observation ends and settlement opens.", ...close },
    {
      title: "Settlement deadline",
      when: formatUtc(m.window.settleDeadline),
      note: "Anyone can settle up to here. After it, the only action left is void.",
      done: now !== null && now > Number(m.window.settleDeadline),
    },
  ];
  return (
    <Panel
      title="Timeline"
      labelledBy="timeline-title"
      aside={<span className="subtle">{m.window.blockClock ? "Block clock" : "UTC clock"}</span>}
    >
      <ol className={s.timeline}>
        {steps.map((step) => (
          <li className={s.step} key={step.title}>
            <span className={`${s.stepDot} ${step.done ? s.stepDone : ""}`} aria-hidden="true" />
            <div className={s.stepBody}>
              <span className={s.stepTitle}>
                {step.title}
                {step.done ? <span className="visually-hidden"> (passed)</span> : null}
              </span>
              <span className={s.stepWhen}>{step.when}</span>
              <span className={s.stepNote}>{step.note}</span>
            </div>
          </li>
        ))}
      </ol>
      {m.window.blockClock ? (
        <p className={s.trust}>
          This market runs on block numbers, so its rule is exact. Clock times are estimates from the chain's
          recent block pace{clock && !clock.measured ? " (nominal pace; not measured yet)" : ""}.
        </p>
      ) : null}
    </Panel>
  );
}

export function SourcePanel({ m }: { m: MarketView }) {
  const source = describeSource(appDeployment, m.decoded, m.resolver);
  return (
    <Panel
      title="Source"
      labelledBy="source-title"
      aside={<span className="subtle">{templateLabel(m.templateId)}</span>}
    >
      <p className={s.stepTitle} style={{ marginBottom: 12 }}>
        {source.title}
      </p>
      <KeyValues
        items={source.items.map((item) => ({
          key: item.label,
          label: item.label,
          value: item.href ? (
            <a href={item.href} target="_blank" rel="noreferrer" className="mono">
              {item.value}
            </a>
          ) : (
            <span className={item.mono ? "mono" : undefined}>{item.value}</span>
          ),
        }))}
      />
      <p className={s.trust}>{source.trust} No person, including the Hunch team, can set the outcome.</p>
    </Panel>
  );
}

export function VoidTermsPanel({ m }: { m: MarketView }) {
  return (
    <Panel title="If there is no answer" labelledBy="void-title">
      <div className={s.prose}>
        {voidTerms(m).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </Panel>
  );
}

export function ContractsPanel({ m }: { m: MarketView }) {
  return (
    <Panel title="Contracts" labelledBy="contracts-title">
      <KeyValues
        items={[
          { label: "Market", value: <AddressLink address={m.address} full /> },
          { label: "YES token", value: <AddressLink address={m.tokens.yes} full /> },
          { label: "NO token", value: <AddressLink address={m.tokens.no} full /> },
          {
            label: "Kuru book",
            value: m.book ? <AddressLink address={m.book} full /> : <span className="subtle">none yet</span>,
          },
          { label: "Creator", value: <AddressLink address={m.creator} full /> },
          { label: "Template", value: `${templateLabel(m.templateId)} (id ${m.templateId})` },
          { label: "Market id", value: <span className="mono">{m.marketId.toString()}</span> },
          { label: "Wallet cap", value: <span className="mono">{formatUsdc(m.caps.walletCap)} USDC</span> },
        ]}
      />
    </Panel>
  );
}
