"use client";

import { ONE_USDC, Phase, Side, templateLabel } from "@hunch-book/shared";
import Link from "next/link";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deckOrder,
  dragIntent,
  dragTransform,
  type Intent,
  isOpen,
  keyIntent,
  stampOpacity,
  withSkip,
} from "@/lib/feed/deck";
import { formatChance, formatUsdc } from "@/lib/format";
import { useChainClock, useMarkets, useNow } from "@/lib/hooks";
import { chanceDisplay, marketChance, PRICE_SCALE } from "@/lib/market/logic";
import type { ChainClock, MarketView } from "@/lib/market/types";
import { formatPriceE6 } from "@/lib/trade/ticket";
import { StakeTicket } from "../market/StakeTicket";
import { Countdown, marketHeadline } from "../markets/MarketCard";
import { ReferralBindPrompt } from "../referral/ReferralBindPrompt";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { Button, ButtonLink, ChanceBar, PhasePill } from "../ui";
import s from "./feed.module.css";
import { Sheet } from "./Sheet";
import { useReducedMotion } from "./useReducedMotion";

const SIDE_NAME: Record<Side, string> = { [Side.Yes]: "YES", [Side.No]: "NO" };

/** What YES and NO cost on the card: pool shares before graduation, book prices after. */
export function sidePrices(m: MarketView): { yes: string; no: string; source: "pool" | "book" } {
  if (m.phase === Phase.Graduated) {
    const toE6 = (v: bigint) => (v * ONE_USDC) / PRICE_SCALE;
    const ask = m.quote?.ask ?? null;
    const bid = m.quote?.bid ?? null;
    return {
      yes: ask === null ? "no asks" : formatPriceE6(toE6(ask), 2),
      no: bid === null ? "no bids" : formatPriceE6(ONE_USDC - toE6(bid), 2),
      source: "book",
    };
  }
  const bps = marketChance(m).bps;
  return {
    yes: bps === null ? "n/a" : formatChance(bps),
    no: bps === null ? "n/a" : formatChance(10_000n - bps),
    source: "pool",
  };
}

function Venue({ m }: { m: MarketView }) {
  if (m.phase === Phase.Graduated) {
    const toE6 = (v: bigint) => (v * ONE_USDC) / PRICE_SCALE;
    return (
      <div className={s.venue}>
        <div className={s.venueRow}>
          <span>Kuru book</span>
          <span>Trading</span>
        </div>
        <span className="mono">
          Bid {m.quote?.bid ? formatPriceE6(toE6(m.quote.bid)) : "none"} · Ask{" "}
          {m.quote?.ask ? formatPriceE6(toE6(m.quote.ask)) : "none"} USDC per YES
        </span>
      </div>
    );
  }
  return (
    <div className={s.venue}>
      <div className={s.venueRow}>
        <span>USDC pool</span>
        <span>Staking</span>
      </div>
      <span className="mono">
        {formatUsdc(m.pool.total)} USDC · {m.pool.stakers} {m.pool.stakers === 1 ? "staker" : "stakers"}
      </span>
    </div>
  );
}

type Motion = "idle" | "dragging" | "settling" | "leaving";

/** A stack of open markets, one card at a time: swipe or press YES, NO or skip. */
export function FeedDeck({
  markets,
  clock,
  now,
}: {
  markets: MarketView[];
  clock: ChainClock | null;
  now: number;
}) {
  const reduced = useReducedMotion();
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [sheet, setSheet] = useState<{ market: MarketView; side: Side } | null>(null);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [motion, setMotion] = useState<Motion>("idle");
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const open = useMemo(() => markets.filter((m) => isOpen(m, clock, now)), [markets, clock, now]);
  const deck = useMemo(() => deckOrder(markets, clock, now, seen), [markets, clock, now, seen]);
  const card = deck[0];
  const next = deck[1];
  const position = open.length - deck.length + 1;

  const advance = useCallback((m: MarketView) => {
    setSeen((prev) => withSkip(prev, m.address));
    setDrag({ dx: 0, dy: 0 });
    setMotion("idle");
  }, []);

  const act = useCallback(
    (intent: Intent) => {
      if (!card || sheet) return;
      if (intent === "skip") {
        if (reduced) {
          advance(card);
          return;
        }
        setMotion("leaving");
        setDrag({ dx: 0, dy: -640 });
        timer.current = setTimeout(() => advance(card), 240);
        return;
      }
      setMotion("settling");
      setDrag({ dx: 0, dy: 0 });
      setSheet({ market: card, side: intent === "yes" ? Side.Yes : Side.No });
    },
    [card, sheet, reduced, advance],
  );

  const closeSheet = useCallback(() => {
    const shown = sheet?.market;
    setSheet(null);
    if (shown) advance(shown);
    // The card that opened the sheet is gone: keep focus in the deck, on the next card or its first button.
    setTimeout(() => {
      const next = root.current?.querySelector<HTMLElement>("article, button");
      next?.focus();
    }, 0);
  }, [sheet, advance]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || sheet || motion === "leaving") return;
    if ((e.target as HTMLElement).closest("a, button")) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setMotion("dragging");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from || from.id !== e.pointerId) return;
    setDrag({ dx: e.clientX - from.x, dy: e.clientY - from.y });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from || from.id !== e.pointerId) return;
    start.current = null;
    const intent = dragIntent(e.clientX - from.x, e.clientY - from.y);
    if (intent) act(intent);
    else {
      setMotion("settling");
      setDrag({ dx: 0, dy: 0 });
    }
  };
  const onPointerCancel = () => {
    start.current = null;
    setMotion("settling");
    setDrag({ dx: 0, dy: 0 });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const intent = keyIntent(e.key);
    if (!intent) return;
    e.preventDefault();
    act(intent);
  };

  if (open.length === 0) {
    return (
      <EmptyState label="Feed" title="No open markets right now">
        <p>
          The feed shows markets you can still take a side on: pools that are filling and books that are
          trading. <Link href="/markets">Browse every market</Link> or <Link href="/create">create one</Link>.
        </p>
      </EmptyState>
    );
  }

  if (!card) {
    return (
      <div className={s.deck} ref={root}>
        <div className={s.done}>
          <span className={s.doneMark} aria-hidden="true">
            ✓
          </span>
          <h2 className={s.doneTitle}>You have seen every open market</h2>
          <p className={s.doneBody}>
            New markets join the feed as they open. Check what you hold, or go through the deck again.
          </p>
          <div className={s.links}>
            <Button variant="primary" onClick={() => setSeen(new Set())}>
              Start over
            </Button>
            <ButtonLink href="/portfolio">Portfolio</ButtonLink>
          </div>
        </div>
      </div>
    );
  }

  const chance = marketChance(card);
  const shown = chanceDisplay(chance);
  const prices = sidePrices(card);
  const headline = marketHeadline(card);
  const cardClass = [
    s.card,
    motion === "settling" ? s.settling : "",
    motion === "leaving" ? `${s.settling} ${s.leaving}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={s.deck} ref={root}>
      <div className={s.topRow}>
        <span className={s.counter} aria-live="polite">
          Market {Math.min(position, open.length)} of {open.length}
        </span>
        <Link href={`/m/${card.address}`}>Full market page</Link>
      </div>

      <div className={s.stack}>
        {next ? <div className={s.behind} aria-hidden="true" /> : null}
        <article
          key={card.address}
          className={cardClass}
          style={{ transform: dragTransform(drag.dx, drag.dy, reduced) }}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the card takes the arrow keys for YES, NO and skip
          tabIndex={0}
          aria-roledescription="market card"
          aria-label={headline}
          aria-describedby="feed-keys"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
          onTransitionEnd={() => motion === "settling" && setMotion("idle")}
        >
          <div className={s.cardMeta}>
            <PhasePill phase={card.phase} outcome={card.outcome} />
            <span>{templateLabel(card.templateId)}</span>
            <span className={s.cardMetaRight}>
              <Countdown m={card} clock={clock} now={now} />
            </span>
          </div>
          <p className={s.question}>{headline}</p>
          <div className={s.chanceRow}>
            <span className={s.chanceValue}>{shown.value}</span>
            <span className={s.chanceCaption}>{shown.caption}</span>
          </div>
          <ChanceBar bps={chance.bps} size="lg" />
          <Venue m={card} />
          <div className={s.tiles}>
            <div className={`${s.tile} ${s.tileNo}`}>
              <div className={s.tileLabel}>NO {prices.source === "book" ? "price" : "share"}</div>
              <div className={s.tileValue}>{prices.no}</div>
            </div>
            <div className={`${s.tile} ${s.tileYes}`}>
              <div className={s.tileLabel}>YES {prices.source === "book" ? "price" : "share"}</div>
              <div className={s.tileValue}>{prices.yes}</div>
            </div>
          </div>
          <span
            className={`${s.stamp} ${s.stampYes}`}
            style={{ opacity: stampOpacity(drag.dx, "yes") }}
            aria-hidden="true"
          >
            YES
          </span>
          <span
            className={`${s.stamp} ${s.stampNo}`}
            style={{ opacity: stampOpacity(drag.dx, "no") }}
            aria-hidden="true"
          >
            NO
          </span>
        </article>
      </div>

      <p className="visually-hidden" id="feed-keys">
        Right arrow or Y takes YES, left arrow or N takes NO, down arrow or S skips. YES and NO open a ticket;
        nothing is sent until you confirm it in your wallet.
      </p>
      <div className={s.hint} aria-hidden="true">
        <span>← NO</span>
        <span>↑ Skip</span>
        <span>YES →</span>
      </div>
      <div className={s.actions}>
        <Button variant="no" size="lg" onClick={() => act("no")} aria-label={`NO on: ${headline}`}>
          <span className={s.actionStack}>
            NO<span className={s.actionDetail}>{prices.no}</span>
          </span>
        </Button>
        <Button variant="ghost" size="lg" onClick={() => act("skip")}>
          Skip
        </Button>
        <Button variant="yes" size="lg" onClick={() => act("yes")} aria-label={`YES on: ${headline}`}>
          <span className={s.actionStack}>
            YES<span className={s.actionDetail}>{prices.yes}</span>
          </span>
        </Button>
      </div>
      <p className={s.footnote}>
        YES and NO open the ticket. Nothing is sent until you confirm it in your wallet.
      </p>

      <Sheet
        open={sheet !== null}
        onClose={closeSheet}
        title={
          sheet ? `${sheet.market.phase === Phase.Pool ? "Stake on" : "Trade"} ${SIDE_NAME[sheet.side]}` : ""
        }
      >
        {sheet ? (
          <>
            <p className="muted" style={{ fontSize: 14 }}>
              {marketHeadline(sheet.market)}
            </p>
            <ReferralBindPrompt />
            <StakeTicket
              key={`${sheet.market.address}-${sheet.side}`}
              m={sheet.market}
              initialSide={sheet.side}
            />
            <Link href={`/m/${sheet.market.address}`}>Open the full market page</Link>
          </>
        ) : null}
      </Sheet>
    </div>
  );
}

/** The feed page body: reads the markets and hands the open ones to the deck. */
export function FeedView() {
  const query = useMarkets();
  const markets = query.data?.status === "ok" ? query.data.data.markets : [];
  const clock = useChainClock(markets.some((m) => m.window.blockClock));
  const now = useNow();
  if (query.isPending || (query.data?.status === "ok" && now === null)) {
    return <LoadingRows rows={2} label="Loading the feed" />;
  }
  if (query.isError)
    return <ErrorState title="Could not load markets" onRetry={() => void query.refetch()} />;
  if (query.data.status !== "ok") return <NotDeployed />;
  return <FeedDeck markets={markets} clock={clock} now={now as number} />;
}
