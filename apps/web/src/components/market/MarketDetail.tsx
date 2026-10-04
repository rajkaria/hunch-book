"use client";

import Link from "next/link";
import type { Address } from "viem";
import { isSeededByUs } from "@/lib/chain/landing";
import { appDeployment, appNetworkLabel } from "@/lib/config";
import { MARKET_WILL_SHOW } from "@/lib/copy";
import { shortAddress } from "@/lib/format";
import { useChainClock, useMarket, useNow } from "@/lib/hooks";
import { phaseLabel, phaseTone } from "@/lib/market/logic";
import { templateLabel } from "@/lib/market/params";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { Countdown, marketHeadline } from "../markets/MarketCard";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { MarketTape } from "../tape/MarketTape";
import { Badge } from "../ui";
import { ActionsPanel } from "./ActionsPanel";
import { BookPanel } from "./BookPanel";
import s from "./market.module.css";
import { PositionPanel } from "./PositionPanel";
import { StakeTicket } from "./StakeTicket";
import {
  ChancePanel,
  ContractsPanel,
  GraduationPanel,
  SourcePanel,
  TimelinePanel,
  VoidTermsPanel,
} from "./sections";

export function Crumbs({ address }: { address: Address }) {
  return (
    <nav className={s.crumbs} aria-label="Breadcrumb">
      <Link href="/markets">Markets</Link>
      <span aria-hidden="true">/</span>
      <span className="mono">{shortAddress(address)}</span>
    </nav>
  );
}

export function MarketBody({
  m,
  clock,
  now,
}: {
  m: MarketView;
  clock: ChainClock | null;
  now: number | null;
}) {
  return (
    <>
      <header className={s.head}>
        <div className={s.headMeta}>
          <Badge tone={phaseTone(m.phase)} dot>
            {phaseLabel(m.phase)}
          </Badge>
          <span>{templateLabel(m.templateId)}</span>
          <span className="mono">Market #{m.marketId.toString()}</span>
          <span className="mono">
            <Countdown m={m} clock={clock} now={now} />
          </span>
          <Link href={`/creator/${m.creator}`}>
            Created by <span className="mono">{shortAddress(m.creator)}</span>
            {isSeededByUs(appDeployment, m.creator) ? " (ours)" : ""}
          </Link>
        </div>
        <h1 className={s.headline}>{marketHeadline(m)}</h1>
        {m.description === null ? (
          <p className="subtle" style={{ fontSize: 14 }}>
            The resolver did not return its rule sentence, so this one is built from the market's parameters.
          </p>
        ) : null}
      </header>
      <div className={s.grid}>
        <div className={s.chanceArea}>
          <ChancePanel m={m} />
        </div>
        <div className={s.main}>
          {m.graduated && m.book ? <BookPanel m={m} /> : null}
          {m.graduated && m.book ? <MarketTape m={m} /> : null}
          <GraduationPanel m={m} />
          <TimelinePanel m={m} clock={clock} now={now} />
          <SourcePanel m={m} />
          <VoidTermsPanel m={m} />
          <ContractsPanel m={m} />
        </div>
        <div className={s.sideCol}>
          <StakeTicket m={m} />
          <PositionPanel m={m} />
          <ActionsPanel m={m} head={clock ? { block: clock.blockNumber, time: clock.timestamp } : null} />
        </div>
      </div>
    </>
  );
}

export function MarketDetail({ address }: { address: Address }) {
  const query = useMarket(address);
  // The head drives countdowns for block-clock markets and every action's time gate.
  const clock = useChainClock(query.data?.status === "ok");
  const now = useNow();

  if (query.isPending) return <LoadingRows rows={3} label="Loading market" />;
  if (query.isError) {
    return <ErrorState title="Could not load this market" onRetry={() => void query.refetch()} />;
  }
  if (query.data.status === "not-deployed") return <NotDeployed willShow={MARKET_WILL_SHOW} />;
  if (query.data.status === "not-market") {
    return (
      <EmptyState label="Not found" title="This address is not a Hunch Book market">
        <p>
          The factory on {appNetworkLabel} does not list <span className="mono">{address}</span>. Check the
          link, or <Link href="/markets">browse every market</Link>.
        </p>
      </EmptyState>
    );
  }
  return <MarketBody m={query.data.data} clock={clock} now={now} />;
}
