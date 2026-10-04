"use client";

import { addressUrl, blockUrl } from "@hunch-book/shared";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import type { Address } from "viem";
import { appDeployment, factoryOf } from "@/lib/config";
import { formatChance, formatDuration, formatInt, formatUsdc, formatUtc, shortAddress } from "@/lib/format";
import type { DataSource } from "@/lib/indexer/source";
import { latestFinal } from "@/lib/proof/chain";
import { type ProofView as ProofModel, useChainTimings, useProof } from "@/lib/proof/hooks";
import type { MarketSolvency, SettlementTiming, VaultBalance } from "@/lib/proof/metrics";
import { tapeStats } from "@/lib/tape/fills";
import { booksOf, useTape } from "@/lib/tape/hooks";
import { INDEXER_DOCS_URL, QUERIES_URL, SourceTag } from "../indexer/SourceTag";
import { ErrorState, LoadingRows } from "../states";
import { windowText } from "../tape/TapeView";
import { AddressLink, Badge, Button, KeyValues, Notice, Panel, Stat, type StatSource, TxLink } from "../ui";
import s from "./proof.module.css";

/** A link to the indexer field a figure comes from. */
const fromIndexer = (field: string): StatSource => ({
  href: QUERIES_URL,
  label: `indexer: ${field}`,
  external: true,
});

const onExplorer = (address: Address | undefined, label: string): StatSource | undefined =>
  address ? { href: addressUrl(appDeployment, address), label, external: true } : undefined;

/** A figure the chain alone cannot give. The page explains why once, at the top. */
function NeedsIndexer({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <Notice tone="accent" title={`${what}: needs the indexer`}>
      {children}
    </Notice>
  );
}

/** Shown once when the page reads the chain: what that means for the figures below. */
function ChainOnly() {
  return (
    <Notice title="Read from the chain directly">
      <p className="muted">
        Market counts and solvency below come straight from the contracts. Distinct wallets, all-time fills
        and volume, and timings across every market count every event since the deploy, which takes the
        indexer. Until it answers, those show no figure rather than an estimate.{" "}
        <a href={INDEXER_DOCS_URL} target="_blank" rel="noreferrer">
          How the indexer counts them
        </a>
        .
      </p>
    </Notice>
  );
}

function MarketsPanel({ data, source }: { data: ProofModel; source: DataSource }) {
  const m = data.markets;
  const factory = factoryOf(appDeployment);
  const covered =
    source === "chain" && m.covered < m.created ? ` (the newest ${formatInt(m.covered)} markets)` : "";
  const phase = (label: string): StatSource =>
    source === "indexer"
      ? fromIndexer(label)
      : { href: "/markets", label: `phase() of each market${covered}` };
  return (
    <Panel title="Markets" labelledBy="proof-markets">
      <div className={s.grid}>
        <Stat
          label="Created"
          value={formatInt(m.created)}
          size="lg"
          source={
            source === "indexer"
              ? fromIndexer("ProtocolStats.marketsCreated")
              : onExplorer(factory, "factory.marketCount()")
          }
        />
        <Stat
          label="Graduated to a book"
          value={formatInt(m.graduated)}
          size="lg"
          source={phase("ProtocolStats.marketsGraduatedTotal")}
        />
        <Stat
          label="Settled"
          value={formatInt(m.settled)}
          size="lg"
          source={phase("ProtocolStats.marketsSettled")}
        />
        <Stat
          label="Voided"
          value={formatInt(m.voided)}
          size="lg"
          source={phase("ProtocolStats.marketsVoided")}
        />
      </div>
      <p className={s.note}>
        Now: {formatInt(m.pools)} {m.pools === 1 ? "pool" : "pools"} taking stakes or locked,{" "}
        {formatInt(m.trading)} {m.trading === 1 ? "book" : "books"} trading or waiting to settle{covered}.
      </p>
    </Panel>
  );
}

function WalletsPanel({ data }: { data: ProofModel }) {
  const w = data.wallets;
  if (!w) {
    return (
      <Panel title="Wallets" labelledBy="proof-wallets">
        <NeedsIndexer what="Distinct wallets that staked or traded" />
      </Panel>
    );
  }
  return (
    <Panel title="Wallets" labelledBy="proof-wallets">
      <div className={s.grid}>
        <Stat
          label="Staked or traded"
          value={formatInt(w.total)}
          size="lg"
          hint="distinct wallets"
          source={fromIndexer("ProtocolStats.wallets")}
        />
        <Stat
          label="Not ours"
          value={formatInt(w.external)}
          size="lg"
          tone="accent"
          source={fromIndexer("ProtocolStats.externalWallets")}
        />
        <Stat
          label="Ours"
          value={formatInt(w.ours)}
          hint="maker, keeper, guardian, seeded stakers"
          source={fromIndexer("ProtocolStats.ourWallets")}
        />
        <Stat
          label="Stakers / traders"
          value={`${formatInt(w.stakers)} / ${formatInt(w.traders)}`}
          source={fromIndexer("ProtocolStats.stakerWallets")}
        />
      </div>
    </Panel>
  );
}

function RecentFillsFromChain({ listed }: { listed: ProofModel["listed"] }) {
  const books = useMemo(() => (listed ? booksOf(listed) : null), [listed]);
  const tape = useTape({ books, limit: 200 });
  const data = tape.data?.data ?? null;
  if (!books || books.length === 0) {
    return <p className={s.note}>No market has graduated to a book yet, so there are no fills to count.</p>;
  }
  if (!data) return <LoadingRows rows={1} label="Reading recent fills" />;
  const stats = tapeStats(data.fills);
  return (
    <div className={s.recent}>
      <p className={s.recentTitle}>
        {data.window
          ? `Meanwhile, from the chain: fills in ${windowText(data.window)}`
          : "Meanwhile: the newest fills the indexer returned"}
      </p>
      <div className={s.grid}>
        <Stat
          label="Fills"
          value={formatInt(stats.fills)}
          source={{ href: "/tape", label: "every fill on the tape" }}
        />
        <Stat
          label="Against our maker"
          value={formatInt(stats.ourMakerFills)}
          hint={
            stats.ourMakerShareBps === null ? "no fills" : `${formatChance(stats.ourMakerShareBps)} of fills`
          }
        />
        <Stat
          label="Between other parties"
          value={formatInt(stats.betweenOthers)}
          hint="neither side is ours"
        />
        <Stat label="Volume" value={formatUsdc(stats.volume)} hint="USDC" />
      </div>
    </div>
  );
}

function TradesPanel({ data }: { data: ProofModel }) {
  const t = data.trades;
  if (!t) {
    return (
      <Panel title="Trades and volume" labelledBy="proof-trades">
        <NeedsIndexer what="All-time fills, volume and our maker's share">
          <RecentFillsFromChain listed={data.listed} />
        </NeedsIndexer>
      </Panel>
    );
  }
  const others = t.fills - t.fillsOurMaker;
  return (
    <Panel title="Trades and volume" labelledBy="proof-trades">
      <div className={s.grid}>
        <Stat
          label="Fills on our books"
          value={formatInt(t.fills)}
          size="lg"
          source={fromIndexer("ProtocolStats.fillCount")}
        />
        <Stat
          label="Volume"
          value={formatUsdc(t.volume)}
          size="lg"
          hint="USDC"
          source={fromIndexer("ProtocolStats.volume")}
        />
        <Stat
          label="Our maker's share of fills"
          value={formatChance(t.ourMakerShareBps)}
          size="lg"
          hint={`${formatChance(t.ourMakerVolumeShareBps)} of volume`}
          source={fromIndexer("ProtocolStats.ourMakerShareBps")}
        />
        <Stat
          label="Fills between other parties"
          value={formatInt(t.fillsBetweenOthers)}
          size="lg"
          tone="accent"
          hint={`${formatUsdc(t.volumeBetweenOthers)} USDC`}
          source={fromIndexer("ProtocolStats.fillCountBetweenOthers")}
        />
      </div>
      <div
        className={s.split}
        role="img"
        aria-label={`Our maker took ${formatInt(t.fillsOurMaker)} of ${formatInt(t.fills)} fills`}
      >
        {t.fills > 0 ? (
          <>
            <span className={s.splitOurs} style={{ flexGrow: t.fillsOurMaker }} />
            <span className={s.splitOthers} style={{ flexGrow: others }} />
          </>
        ) : null}
      </div>
      <KeyValues
        items={[
          {
            label: "Against our maker (ours)",
            value: `${formatInt(t.fillsOurMaker)} fills, ${formatUsdc(t.volumeOurMaker)} USDC`,
          },
          { label: "Our wallets taking", value: `${formatInt(t.fillsOurTrader)} fills` },
          {
            label: "Router trades",
            value: `${formatInt(t.routerTrades)}, ${formatUsdc(t.routerVolume)} USDC`,
          },
        ]}
      />
    </Panel>
  );
}

function latencyText(t: SettlementTiming): string {
  if (t.latency === null) return "n/a";
  if (t.early) return "early, from a touch proof";
  return t.latencyUnit === "blocks"
    ? `${formatInt(t.latency)} blocks after close`
    : `${formatDuration(t.latency)} after close`;
}

function TimingTable({ rows, caption }: { rows: SettlementTiming[]; caption: string }) {
  if (rows.length === 0) return <p className={s.note}>No market has settled or voided yet.</p>;
  return (
    <div className={s.scroll}>
      <table className={s.table}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Result</th>
            <th scope="col">Window end to settlement</th>
            <th scope="col">Settlement to first redemption</th>
            <th scope="col">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.market}>
              <td>
                <Link href={`/m/${t.market}`} title={t.question ?? undefined}>
                  {t.number !== null ? `#${t.number}` : shortAddress(t.market)}
                </Link>
              </td>
              <td>{t.voided ? "Voided" : t.outcome ? `Settled ${t.outcome.toUpperCase()}` : "Settled"}</td>
              <td>{latencyText(t)}</td>
              <td>
                {t.toFirstRedemption === null ? "no redemption yet" : formatDuration(t.toFirstRedemption)}
              </td>
              <td>
                <TxLink hash={t.tx} />{" "}
                <a
                  className={s.subtle}
                  href={blockUrl(appDeployment, t.block)}
                  target="_blank"
                  rel="noreferrer"
                >
                  block {formatInt(t.block)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChainTimings({ listed }: { listed: ProofModel["listed"] }) {
  const finals = useMemo(() => latestFinal(listed ?? []), [listed]);
  const timings = useChainTimings(finals);
  if (finals.length === 0) return <p className={s.note}>No market has settled or voided yet.</p>;
  return (
    <div className={s.recent}>
      <p className={s.recentTitle}>
        Meanwhile, from the chain: time the newest{" "}
        {finals.length === 1 ? "final market" : `${finals.length} final markets`} by searching past blocks for
        the settlement and the first redemption.
      </p>
      {!timings.started ? (
        <Button size="sm" onClick={timings.start}>
          Measure from the chain
        </Button>
      ) : timings.isPending ? (
        <LoadingRows rows={1} label="Searching past blocks" />
      ) : timings.isError ? (
        <p className={s.note}>The RPC could not answer the archive reads. Try again later.</p>
      ) : (
        <TimingTable rows={timings.data ?? []} caption="Settlement timing measured from the chain" />
      )}
    </div>
  );
}

function TimingPanel({ data }: { data: ProofModel }) {
  const t = data.timing;
  if (!t) {
    return (
      <Panel title="Settlement timing" labelledBy="proof-timing">
        <NeedsIndexer what="Average time from window end to settlement, and to redemption">
          <ChainTimings listed={data.listed} />
        </NeedsIndexer>
      </Panel>
    );
  }
  return (
    <Panel title="Settlement timing" labelledBy="proof-timing">
      <div className={s.grid}>
        <Stat
          label="Window end to settlement"
          value={t.avgSettleSeconds === null ? "n/a" : formatDuration(t.avgSettleSeconds)}
          hint={`average over ${formatInt(t.settlementsTimed)} price ${t.settlementsTimed === 1 ? "market" : "markets"}`}
          source={fromIndexer("ProtocolStats.avgSettlementLatencySeconds")}
        />
        <Stat
          label="Perpl markets"
          value={t.avgSettleBlocks === null ? "n/a" : `${formatInt(t.avgSettleBlocks)} blocks`}
          hint={`average over ${formatInt(t.settlementsBlockClock)}`}
          source={fromIndexer("ProtocolStats.avgSettlementLatencyBlocks")}
        />
        <Stat
          label="Settlement to first redemption"
          value={t.avgFirstRedemptionSeconds === null ? "n/a" : formatDuration(t.avgFirstRedemptionSeconds)}
          hint={`average over ${formatInt(t.marketsRedeemed)} ${t.marketsRedeemed === 1 ? "market" : "markets"}`}
          source={fromIndexer("ProtocolStats.avgSecondsToFirstRedemption")}
        />
        <Stat
          label="Settled early"
          value={formatInt(t.earlySettlements)}
          hint="touch markets proven before close"
          source={fromIndexer("ProtocolStats.earlySettlements")}
        />
      </div>
      <TimingTable rows={data.settlements} caption="Latest settlements and their timing" />
    </Panel>
  );
}

function VaultFigures({
  vault,
  live,
  source,
}: {
  vault: VaultBalance | null;
  live: VaultBalance | null;
  source: DataSource;
}) {
  const vaultAddress = appDeployment.hunchBook.vault;
  const shown = live ?? vault;
  if (!shown) return <p className={s.note}>The vault's books could not be read just now.</p>;
  return (
    <div className={s.grid}>
      <Stat
        label="Vault margin"
        value={formatUsdc(shown.margin)}
        size="lg"
        tone={shown.margin < 0n ? "no" : "accent"}
        hint="USDC held minus everything owed"
        source={onExplorer(vaultAddress, "live: USDC.balanceOf(vault) − vault.totalObligations()")}
      />
      <Stat
        label="USDC held"
        value={formatUsdc(shown.balance)}
        source={onExplorer(vaultAddress, "the vault on the explorer")}
      />
      <Stat label="Owed" value={formatUsdc(shown.obligations)} hint="pools, sets and unpaid fees" />
      {source === "indexer" && vault ? (
        <Stat
          label="Replayed by the indexer"
          value={formatUsdc(vault.margin)}
          hint="the same margin from every vault event"
          source={fromIndexer("ProtocolStats.solvencyMargin")}
        />
      ) : null}
    </div>
  );
}

function SolvencyTable({ rows, source }: { rows: MarketSolvency[]; source: DataSource }) {
  if (rows.length === 0) return <p className={s.note}>No markets yet.</p>;
  return (
    <div className={s.scroll}>
      <table className={s.table}>
        <caption className="visually-hidden">Solvency per market</caption>
        <thead>
          {source === "indexer" ? (
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Stage</th>
              <th scope="col" className={s.num}>
                USDC in
              </th>
              <th scope="col" className={s.num}>
                USDC out
              </th>
              <th scope="col" className={s.num}>
                Owed
              </th>
              <th scope="col" className={s.num}>
                Fees
              </th>
              <th scope="col" className={s.num}>
                Margin
              </th>
            </tr>
          ) : (
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Stage</th>
              <th scope="col" className={s.num}>
                Pool
              </th>
              <th scope="col" className={s.num}>
                Sets
              </th>
              <th scope="col" className={s.num}>
                YES supply
              </th>
              <th scope="col" className={s.num}>
                NO supply
              </th>
              <th scope="col">Backed</th>
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.market}>
              <td>
                <Link href={`/m/${r.market}`} title={r.question ?? undefined}>
                  {r.number !== null ? `#${r.number}` : shortAddress(r.market)}
                </Link>{" "}
                <AddressLink address={r.market} />
              </td>
              <td>{r.stage}</td>
              {source === "indexer" ? (
                <>
                  <td className={`${s.num} mono`}>{formatUsdc(r.collateralIn ?? 0n)}</td>
                  <td className={`${s.num} mono`}>{formatUsdc(r.collateralOut ?? 0n)}</td>
                  <td className={`${s.num} mono`}>{formatUsdc(r.owed)}</td>
                  <td className={`${s.num} mono`}>{formatUsdc(r.fees ?? 0n)}</td>
                  <td className={`${s.num} mono ${(r.margin ?? 0n) < 0n ? s.bad : s.good}`}>
                    {formatUsdc(r.margin ?? 0n)}
                  </td>
                </>
              ) : (
                <>
                  <td className={`${s.num} mono`}>{formatUsdc(r.pool)}</td>
                  <td className={`${s.num} mono`}>{formatUsdc(r.sets)}</td>
                  <td className={`${s.num} mono`}>
                    {r.yesSupply === null ? "n/a" : formatUsdc(r.yesSupply)}
                  </td>
                  <td className={`${s.num} mono`}>{r.noSupply === null ? "n/a" : formatUsdc(r.noSupply)}</td>
                  <td>
                    {r.backed === null ? (
                      <span className={s.subtle}>
                        {r.stage.startsWith("Pool") ? "pool: USDC held" : "settled"}
                      </span>
                    ) : r.backed ? (
                      <span className={s.good}>sets = YES = NO</span>
                    ) : (
                      <span className={s.bad}>mismatch</span>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SolvencyPanel({ data, source }: { data: ProofModel; source: DataSource }) {
  return (
    <Panel title="Solvency" labelledBy="proof-solvency">
      <VaultFigures vault={data.vault} live={data.liveVault} source={source} />
      {data.negative.length > 0 ? (
        <Notice tone="danger" title="A market shows a negative margin" role="alert">
          <p>
            {data.negative.map((m) => `#${m.number ?? "?"}`).join(", ")}. This should never happen; the
            indexer may be missing an event. The vault margin above is read live from the chain.
          </p>
        </Notice>
      ) : null}
      <h3 className={s.subhead}>Per market</h3>
      <p className={s.note}>
        {source === "indexer"
          ? "USDC into the vault for each market, minus USDC out, minus what it still owes, minus its fees. Zero when every event is accounted for; it should never be negative."
          : "Read live from the vault's ledger and each token: before settlement every set is one YES, one NO and one USDC, so sets must equal both supplies. The USDC margin per market needs the indexer."}
      </p>
      <SolvencyTable rows={data.perMarket} source={source} />
    </Panel>
  );
}

function DailyPanel({ data }: { data: ProofModel }) {
  if (data.daily.length === 0) return null;
  return (
    <Panel
      title="Last 30 days"
      labelledBy="proof-daily"
      aside={
        <a className={s.subtle} href={QUERIES_URL} target="_blank" rel="noreferrer">
          indexer: DailyStats ↗
        </a>
      }
    >
      <div className={s.scroll}>
        <table className={s.table}>
          <caption className="visually-hidden">Activity per UTC day</caption>
          <thead>
            <tr>
              <th scope="col">Day (UTC)</th>
              <th scope="col" className={s.num}>
                Markets
              </th>
              <th scope="col" className={s.num}>
                Stakes
              </th>
              <th scope="col" className={s.num}>
                Fills
              </th>
              <th scope="col" className={s.num}>
                Against our maker
              </th>
              <th scope="col" className={s.num}>
                Volume
              </th>
              <th scope="col" className={s.num}>
                Active wallets
              </th>
              <th scope="col" className={s.num}>
                New wallets
              </th>
            </tr>
          </thead>
          <tbody>
            {data.daily.map((d) => (
              <tr key={d.date}>
                <td className="mono">{d.date}</td>
                <td className={`${s.num} mono`}>{formatInt(d.marketsCreated)}</td>
                <td className={`${s.num} mono`}>{formatInt(d.stakes)}</td>
                <td className={`${s.num} mono`}>{formatInt(d.fills)}</td>
                <td className={`${s.num} mono`}>{formatInt(d.fillsOurMaker)}</td>
                <td className={`${s.num} mono`}>{formatUsdc(d.volume)}</td>
                <td className={`${s.num} mono`}>
                  {formatInt(d.activeWallets)}
                  <span className={s.subtle}> ({formatInt(d.activeOurWallets)} ours)</span>
                </td>
                <td className={`${s.num} mono`}>{formatInt(d.newWallets)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function OurWallets() {
  const { maker, keeper } = appDeployment.wallets;
  const { guardian, feeRecipient } = appDeployment.hunchBook;
  const factory = factoryOf(appDeployment);
  return (
    <Panel title="Our own wallets" labelledBy="proof-ours">
      <p className={s.note}>
        These addresses belong to Hunch. Their activity is labelled as ours wherever it is counted, so it
        never passes for outside demand. The indexer also counts wallets whose stake one of these paid for as
        ours.
      </p>
      <KeyValues
        items={[
          { label: "Maker bot (ours)", value: <AddressLink address={maker} full /> },
          { label: "Keeper (ours)", value: <AddressLink address={keeper} full /> },
          ...(guardian ? [{ label: "Guardian (ours)", value: <AddressLink address={guardian} full /> }] : []),
          ...(feeRecipient && feeRecipient !== guardian
            ? [{ label: "Fee recipient (ours)", value: <AddressLink address={feeRecipient} full /> }]
            : []),
          {
            label: "Factory",
            value: factory ? (
              <AddressLink address={factory} full />
            ) : (
              <span className="subtle">not deployed yet</span>
            ),
          },
        ]}
      />
    </Panel>
  );
}

/** The proof page: usage and solvency, each figure linked to where it comes from. */
export function ProofView() {
  const proof = useProof();
  if (proof.isPending) return <LoadingRows rows={3} label="Counting from the chain" />;
  if (proof.isError) {
    return <ErrorState title="Could not read the figures" onRetry={() => void proof.refetch()} />;
  }
  const { data, source, fallback, indexedBlock } = proof.data;
  return (
    <div className={s.stack}>
      <div className={s.sourceRow}>
        <SourceTag source={source} fallback={fallback} indexedBlock={indexedBlock} />
        <Badge tone="muted">updated {formatUtc(Math.floor(proof.dataUpdatedAt / 1000))}</Badge>
      </div>
      {source === "chain" ? <ChainOnly /> : null}
      <MarketsPanel data={data} source={source} />
      <WalletsPanel data={data} />
      <TradesPanel data={data} />
      <TimingPanel data={data} />
      <SolvencyPanel data={data} source={source} />
      <DailyPanel data={data} />
      <OurWallets />
    </div>
  );
}
