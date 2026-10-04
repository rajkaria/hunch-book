import { addressUrl, type Deployment, type GraduationRule } from "@hunch-book/shared";
import type { ReactNode } from "react";
import type { LandingStats } from "@/lib/chain/landing";
import { appDeployment, appNetworkLabel } from "@/lib/config";
import { formatBpsPercent, formatInt } from "@/lib/format";
import { Badge } from "../ui";
import s from "./landing.module.css";
import { PROTOCOL, ruleWords, usdcWords } from "./words";

export interface Stage {
  key: "pool" | "book" | "settle";
  title: string;
  body: string;
  facts: ReactNode[];
  /** Status word for this stage on the app's network (CLAUDE.md Rule 4). */
  status: "live" | "building" | "planned";
  more: { href: string; label: string };
}

/** The three stages, with the graduation rule and the settled count only when they were read. */
export function lifecycleSteps(
  rule: GraduationRule | null,
  stats: LandingStats | null = null,
  deployment: Deployment = appDeployment,
): Stage[] {
  const { perplFunding, priceAtTime } = deployment.hunchBook.resolvers ?? {};
  // Each stage is live only where the contracts behind it are in deployments/<network>.json.
  const poolLive = Boolean(deployment.hunchBook.factory && deployment.hunchBook.vault);
  const bookLive = Boolean(deployment.hunchBook.graduator && deployment.hunchBook.router);
  const resolversLive = Boolean(perplFunding && priceAtTime);
  return [
    {
      key: "pool",
      title: "Pool",
      body: "Stake USDC on YES or NO. The split of the pool is the market's chance, so a new question works from its first dollar, with no market maker.",
      facts: ["chance = YES stakes / whole pool", "stakes stay in until settlement"],
      status: poolLive ? "live" : "building",
      more: { href: PROTOCOL.lifecycle, label: "The lifecycle" },
    },
    {
      key: "book",
      title: "Book",
      body: rule
        ? `When the pool holds ${ruleWords(rule)}, anyone can graduate it. One transaction turns it into fully backed YES and NO tokens, keeps every staker's payout the same, and opens a YES/USDC book on Kuru.`
        : "When the pool meets its graduation rule, anyone can graduate it. One transaction turns it into fully backed YES and NO tokens, keeps every staker's payout the same, and opens a YES/USDC book on Kuru.",
      facts: rule
        ? [
            `pool ≥ ${usdcWords(rule.minPool)}`,
            `stakers ≥ ${formatInt(rule.minStakers)}`,
            `chance ${formatBpsPercent(rule.minChanceBps)} to ${formatBpsPercent(rule.maxChanceBps)}`,
            "sell YES or NO any time",
          ]
        : ["rule read from the factory", "sell YES or NO any time"],
      status: bookLive ? "live" : "building",
      more: { href: PROTOCOL.graduation, label: "How graduation works" },
    },
    {
      key: "settle",
      title: "Settle",
      body: "When the window closes, anyone can settle. A resolver contract reads the answer from Perpl's funding history or a Chainlink price, and winning tokens pay out in USDC.",
      facts: [
        "no one sets the outcome",
        "void if the source never answers",
        stats
          ? stats.settled > 0
            ? `${formatInt(stats.settled)} settled so far`
            : "no market has settled yet"
          : null,
        resolversLive && perplFunding && priceAtTime ? (
          <span key="resolvers">
            resolvers:{" "}
            <a href={addressUrl(deployment, perplFunding)} target="_blank" rel="noreferrer">
              Perpl funding
            </a>
            ,{" "}
            <a href={addressUrl(deployment, priceAtTime)} target="_blank" rel="noreferrer">
              price at a time
            </a>
          </span>
        ) : null,
      ].filter(Boolean),
      status: resolversLive ? "live" : "building",
      more: { href: PROTOCOL.settlement, label: "How settlement works" },
    },
  ];
}

const STATUS_WORDS: Record<Stage["status"], string> = {
  live: `Live on ${appNetworkLabel}`,
  building: "Building",
  planned: "Planned",
};

/**
 * The lifecycle as a picture: Pool, Book, Settle, and the path a pool takes when it never graduates.
 * Two drawings of the same thing, wide for desktop and tall for phones; CSS shows one.
 */
export function LifecycleDiagram({ rule }: { rule: GraduationRule | null }) {
  const gradLabel = rule ? `${usdcWords(rule.minPool)}, ${formatInt(rule.minStakers)} wallets` : "rule met";
  const label =
    "Lifecycle: a pool graduates into a Kuru order book when its rule is met, and the book settles from the chain when the window closes. A pool that never graduates settles as a pool.";
  return (
    <div className={s.diagram}>
      <svg className={s.diagramWide} viewBox="0 0 1000 236" role="img" aria-label={label}>
        <defs>
          <marker
            id="lc-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0 10 5 0 10z" className={s.dgArrowHead} />
          </marker>
        </defs>
        {/* the branch a pool takes when it never graduates */}
        <path
          d="M118 136 V196 Q118 214 136 214 H864 Q882 214 882 196 V136"
          className={s.dgBranch}
          markerEnd="url(#lc-arrow)"
        />
        <rect x="356" y="200" width="288" height="28" rx="14" className={s.dgChip} />
        <text x="500" y="219" className={s.dgChipText} textAnchor="middle">
          never graduates: settles as a pool
        </text>

        <path d="M232 88 H384" className={s.dgFlow} markerEnd="url(#lc-arrow)" />
        <text x="309" y="72" className={s.dgEdge} textAnchor="middle">
          graduate
        </text>
        <text x="309" y="114" className={s.dgEdgeNote} textAnchor="middle">
          {gradLabel}
        </text>
        <path d="M614 88 H766" className={s.dgFlow} markerEnd="url(#lc-arrow)" />
        <text x="691" y="72" className={s.dgEdge} textAnchor="middle">
          window closes
        </text>
        <text x="691" y="114" className={s.dgEdgeNote} textAnchor="middle">
          anyone can settle
        </text>

        <g>
          <rect x="10" y="40" width="216" height="96" rx="20" className={`${s.dgNode} ${s.dgPool}`} />
          <text x="34" y="76" className={`${s.dgKicker} ${s.dgKickerPool}`}>
            01 POOL
          </text>
          <text x="34" y="108" className={s.dgTitle}>
            Stake YES or NO
          </text>
        </g>
        <g>
          <rect x="392" y="40" width="216" height="96" rx="20" className={`${s.dgNode} ${s.dgBook}`} />
          <text x="416" y="76" className={`${s.dgKicker} ${s.dgKickerBook}`}>
            02 BOOK
          </text>
          <text x="416" y="108" className={s.dgTitle}>
            Trade on Kuru
          </text>
        </g>
        <g>
          <rect x="774" y="40" width="216" height="96" rx="20" className={`${s.dgNode} ${s.dgSettle}`} />
          <text x="798" y="76" className={`${s.dgKicker} ${s.dgKickerSettle}`}>
            03 SETTLE
          </text>
          <text x="798" y="108" className={s.dgTitle}>
            Read the chain
          </text>
        </g>
      </svg>

      <svg className={s.diagramTall} viewBox="0 0 340 452" role="img" aria-label={label}>
        <defs>
          <marker
            id="lc-arrow-tall"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0 10 5 0 10z" className={s.dgArrowHead} />
          </marker>
        </defs>
        <path
          d="M262 50 H300 Q316 50 316 66 V386 Q316 402 300 402 H266"
          className={s.dgBranch}
          markerEnd="url(#lc-arrow-tall)"
        />
        <text x="330" y="226" className={s.dgChipText} textAnchor="middle" transform="rotate(90 330 226)">
          never graduates: settles as a pool
        </text>

        <g>
          <rect x="10" y="6" width="250" height="88" rx="20" className={`${s.dgNode} ${s.dgPool}`} />
          <text x="32" y="40" className={`${s.dgKicker} ${s.dgKickerPool}`}>
            01 POOL
          </text>
          <text x="32" y="72" className={s.dgTitle}>
            Stake YES or NO
          </text>
        </g>
        <path d="M135 98 V170" className={s.dgFlow} markerEnd="url(#lc-arrow-tall)" />
        <text x="150" y="130" className={s.dgEdge}>
          graduate
        </text>
        <text x="150" y="150" className={s.dgEdgeNote}>
          {gradLabel}
        </text>
        <g>
          <rect x="10" y="182" width="250" height="88" rx="20" className={`${s.dgNode} ${s.dgBook}`} />
          <text x="32" y="216" className={`${s.dgKicker} ${s.dgKickerBook}`}>
            02 BOOK
          </text>
          <text x="32" y="248" className={s.dgTitle}>
            Trade on Kuru
          </text>
        </g>
        <path d="M135 274 V346" className={s.dgFlow} markerEnd="url(#lc-arrow-tall)" />
        <text x="150" y="306" className={s.dgEdge}>
          window closes
        </text>
        <text x="150" y="326" className={s.dgEdgeNote}>
          anyone can settle
        </text>
        <g>
          <rect x="10" y="358" width="250" height="88" rx="20" className={`${s.dgNode} ${s.dgSettle}`} />
          <text x="32" y="392" className={`${s.dgKicker} ${s.dgKickerSettle}`}>
            03 SETTLE
          </text>
          <text x="32" y="424" className={s.dgTitle}>
            Read the chain
          </text>
        </g>
      </svg>
    </div>
  );
}

export function HowItWorks({ rule, stats }: { rule: GraduationRule | null; stats: LandingStats | null }) {
  return (
    <section className={s.section} id="how-it-works" aria-labelledby="how-title">
      <div className={s.wrap}>
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>
            <span className={s.eyebrowMark} aria-hidden="true" />
            How it works
          </p>
          <h2 className={s.h2} id="how-title">
            A market starts as a pool and grows into a book
          </h2>
          <p className={s.lede}>
            Pools need no market maker, so a new question works from its first stake. Once people show up, the
            market graduates into an order book you can trade in and out of, and it ends by reading the chain.
          </p>
        </div>
        <LifecycleDiagram rule={rule} />
        <ol className={s.stages}>
          {lifecycleSteps(rule, stats).map((stage, i) => (
            <li className={`${s.stage} ${s[`stage-${stage.key}`] ?? ""}`} key={stage.key}>
              <div className={s.stageHead}>
                <span className={s.stageIndex}>{`0${i + 1}`}</span>
                <Badge tone={stage.status === "live" ? "accent" : "warn"} dot>
                  {STATUS_WORDS[stage.status]}
                </Badge>
              </div>
              <h3 className={s.stageTitle}>{stage.title}</h3>
              <p className={s.stageBody}>{stage.body}</p>
              <ul className={s.facts}>
                {stage.facts.map((fact, j) => (
                  // Facts are short fixed strings or one link group; their order never changes.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list
                  <li key={j}>{fact}</li>
                ))}
              </ul>
              <a className={s.stageMore} href={stage.more.href} target="_blank" rel="noreferrer">
                {stage.more.label}
                <span aria-hidden="true"> ↗</span>
              </a>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
