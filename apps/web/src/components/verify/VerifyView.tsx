"use client";

import { blockUrl, decodeChainlinkEvidence, Outcome, Phase } from "@hunch-book/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Address, Hex } from "viem";
import { appDeployment, appNetworkLabel } from "@/lib/config";
import { VERIFY_WILL_SHOW } from "@/lib/copy";
import { formatDuration, formatE8Usd, formatFixed, formatInt, formatUtc } from "@/lib/format";
import { useMarket, useSettlementTx, useVerification } from "@/lib/hooks";
import { phaseLabel } from "@/lib/market/logic";
import { describeSource, perpName, templateLabel } from "@/lib/market/params";
import type { MarketView } from "@/lib/market/types";
import {
  type ChainlinkRead,
  isCheckedRead,
  type PerplRead,
  type SettlementTx,
  type Verification,
} from "@/lib/verify/read";
import { marketHeadline } from "../markets/MarketCard";
import { EmptyState, ErrorState, LoadingRows, NotDeployed } from "../states";
import { AddressLink, Badge, Button, KeyValues, Notice, Panel, TxLink } from "../ui";
import { SnapshotReadPanel } from "./SnapshotReadPanel";
import v from "./verify.module.css";

const ZERO_HASH = `0x${"00".repeat(32)}`;

export function outcomeWords(m: Pick<MarketView, "phase" | "outcome">): string {
  if (m.phase === Phase.Voided) return "Voided: no answer before the settlement deadline";
  if (m.outcome === Outcome.Yes) return "YES";
  if (m.outcome === Outcome.No) return "NO";
  return "Not settled";
}

const OUTCOME: Record<number, string> = {
  [Outcome.Unresolved]: "Unresolved",
  [Outcome.Yes]: "YES",
  [Outcome.No]: "NO",
};

function MatchBadge({ value, label }: { value: boolean | null; label?: string }) {
  if (value === null) return <Badge tone="muted">{label ?? "not compared"}</Badge>;
  return value ? (
    <Badge tone="accent" dot>
      Match
    </Badge>
  ) : (
    <Badge tone="no" dot>
      Mismatch
    </Badge>
  );
}

const mono = (value: ReactNode) => <span className="mono">{value}</span>;

/** The round id in S-2 Chainlink evidence, or null if the bytes are not that shape. */
function safeRound(evidence: Hex): bigint | null {
  try {
    return evidence.length === 66 ? decodeChainlinkEvidence(evidence) : null;
  } catch {
    return null;
  }
}

/** A raw Perpl amount and its USD value per unit: raw / 10^(priceDecimals + fundingSumScalingExp). */
function perplUsd(raw: bigint, read: PerplRead): string {
  if (read.priceDecimals === null || read.scalingExp === null) return raw.toString();
  const decimals = read.priceDecimals + read.scalingExp;
  const negative = raw < 0n;
  const usd = formatFixed(negative ? -raw : raw, decimals, {
    minDecimals: 2,
    maxDecimals: Math.min(decimals, 6),
  });
  return `${raw.toString()} raw (${negative ? "-" : ""}$${usd} per ${read.symbol ?? "unit"})`;
}

function PerplReadPanel({ read, m }: { read: PerplRead; m: MarketView }) {
  const name = perpName(appDeployment, read.perpId) ?? read.symbol ?? `perp ${read.perpId.toString()}`;
  // The resolver's pause check (last event more than two intervals before endBlock), once the window is final.
  const stale =
    read.final && read.end && read.interval !== null
      ? read.endBlock - read.end.eventBlock > 2n * read.interval
      : null;
  const items = [
    {
      label: "Contract",
      value: <AddressLink address={read.exchange} full label={`Perpl Exchange ${read.exchange}`} />,
    },
    { label: "Perp", value: `${name} (id ${read.perpId.toString()})` },
    {
      label: `getFundingSumAtBlock(${read.perpId}, ${read.startBlock})`,
      value: read.start
        ? mono(
            `F(start) = ${read.start.sum.toString()}, last event at block ${formatInt(read.start.eventBlock)}`,
          )
        : read.started
          ? "could not be read"
          : "the window has not started",
    },
    {
      label: `getFundingSumAtBlock(${read.perpId}, ${read.endRead})`,
      value: read.end
        ? mono(
            `F(${read.final ? "end" : "so far"}) = ${read.end.sum.toString()}, last event at block ${formatInt(read.end.eventBlock)}`,
          )
        : read.started
          ? "could not be read"
          : "the window has not started",
    },
    {
      label: "Scaling",
      value:
        read.priceDecimals === null || read.scalingExp === null
          ? "could not read getPerpetualInfoV2"
          : mono(
              `priceDecimals ${read.priceDecimals} + fundingSumScalingExp ${read.scalingExp} (market expects ${read.expectedScalingExp}): divide by 10^${read.priceDecimals + read.scalingExp}`,
            ),
    },
    {
      label: "ΔF = F(end) − F(start)",
      value: read.delta === null ? "n/a" : mono(perplUsd(read.delta, read)),
    },
    { label: "Threshold X", value: mono(perplUsd(read.threshold, read)) },
    {
      label: "Rule",
      value: (
        <>
          YES if ΔF &gt; X, otherwise NO (equal is NO):{" "}
          <strong>{read.outcome === null ? "n/a" : OUTCOME[read.outcome]}</strong>
          {read.final ? null : " so far"}
        </>
      ),
    },
    {
      label: "Resolver checks",
      value: (
        <>
          Perpl version{" "}
          {read.versionUnchanged === null ? "unknown" : read.versionUnchanged ? "unchanged" : "changed"}
          {stale === null
            ? null
            : stale
              ? ", last funding event too old (paused)"
              : ", funding events current"}
          {read.interval === null ? null : `, interval ${formatInt(read.interval)} blocks`}
        </>
      ),
    },
  ];
  return (
    <Panel
      title="The read"
      labelledBy="verify-read"
      aside={
        <span className="subtle">{read.final ? "final" : `preview at block ${formatInt(read.endRead)}`}</span>
      }
    >
      <KeyValues items={items} />
      <p className={v.note}>
        Perpl keeps its funding history in contract storage, so these reads give the same answer at any later
        block. Settlement needs block.number &gt; {formatInt(m.window.close)}, after which every funding event
        in the window is final.
      </p>
    </Panel>
  );
}

function ChainlinkReadPanel({ read, tx }: { read: ChainlinkRead; tx: SettlementTx | null | undefined }) {
  const b = read.bracket;
  const items: { label: ReactNode; value: ReactNode; key?: string }[] = [
    {
      label: "Contract",
      value: <AddressLink address={read.feed} full label={`Chainlink feed ${read.feed}`} />,
    },
    { label: "Close T", value: mono(`${formatUtc(read.target)} (unix ${read.target.toString()})`) },
    { label: "Strike", value: mono(formatE8Usd(read.strikeE8)) },
  ];
  if (read.bracketError)
    items.push({ label: "Rounds", value: `Could not read the feed: ${read.bracketError}` });
  if (b?.status === "waiting") {
    items.push({
      label: "Rounds",
      value: `No round after T yet. The latest round updated at ${formatUtc(b.latest.updatedAt)}.`,
    });
  }
  if (b?.status === "phase-start") {
    items.push({
      label: "Rounds",
      value:
        "The feed's current phase starts after T, so no round in it brackets T. The market voids at its deadline.",
    });
  }
  if (b?.status === "found" || b?.status === "stale") {
    items.push(
      {
        key: "r",
        label: `getRoundData(${b.round.roundId})`,
        value: mono(
          `answer ${b.round.answer.toString()}, updatedAt ${formatUtc(b.round.updatedAt)} (${b.round.updatedAt})`,
        ),
      },
      {
        key: "r1",
        label: `getRoundData(${b.next.roundId})`,
        value: mono(`updatedAt ${formatUtc(b.next.updatedAt)} (${b.next.updatedAt})`),
      },
      {
        label: "Bracket",
        value: (
          <>
            updatedAt(r) ≤ T &lt; updatedAt(r + 1), same phase. Round r is {formatDuration(b.staleSeconds)}{" "}
            before T
            {b.status === "stale"
              ? ", more than the one hour the resolver accepts: it refuses"
              : " (at most one hour)"}
            .
          </>
        ),
      },
      {
        label: "Price",
        value:
          read.priceE8 === null
            ? "n/a"
            : mono(
                `${formatE8Usd(read.priceE8)} (answer with ${read.decimals ?? "?"} decimals, from the round's phase aggregator)`,
              ),
      },
      {
        label: "Rule",
        value: (
          <>
            YES if the price is at or above the strike:{" "}
            <strong>{read.outcome === null ? "n/a" : OUTCOME[read.outcome]}</strong>
          </>
        ),
      },
    );
  }
  const settledRound = tx?.evidence ? safeRound(tx.evidence) : null;
  if (settledRound !== null) {
    const same = b?.status === "found" || b?.status === "stale" ? b.round.roundId === settledRound : null;
    items.push({
      label: "Round in the settle call",
      value: (
        <span className={v.compare}>
          {mono(settledRound.toString())}
          <MatchBadge value={same} label="no bracket to compare" />
        </span>
      ),
    });
  }
  return (
    <Panel
      title="The read"
      labelledBy="verify-read"
      aside={<span className="subtle">Chainlink round that brackets T</span>}
    >
      <KeyValues items={items} />
      <p className={v.note}>
        Exactly one round brackets T, so nobody can pick a convenient price. The page finds it by walking the
        feed's rounds back from latestRoundData(), the same rule the resolver checks.
      </p>
    </Panel>
  );
}

function StoredPanel({
  m,
  tx,
  loading,
}: {
  m: MarketView;
  tx: SettlementTx | null | undefined;
  loading: boolean;
}) {
  const source = describeSource(appDeployment, m.decoded, m.resolver);
  let where: ReactNode;
  if (loading) where = "Finding the settlement transaction...";
  else if (!tx) where = "Could not locate it from this RPC. The indexer will list it.";
  else
    where = (
      <>
        <TxLink hash={tx.hash} /> in block{" "}
        <a href={blockUrl(appDeployment, tx.block)} target="_blank" rel="noreferrer" className="mono">
          {formatInt(tx.block)}
        </a>{" "}
        at {formatUtc(tx.time)}
      </>
    );
  return (
    <Panel title="What the market stored" labelledBy="verify-settled">
      <KeyValues
        items={[
          { label: "Outcome", value: <strong>{outcomeWords(m)}</strong> },
          {
            label: "Evidence hash",
            value: mono(m.evidenceHash === ZERO_HASH ? "none stored" : m.evidenceHash),
          },
          { label: "Resolver", value: <AddressLink address={m.resolver} full /> },
          { label: "Transaction", value: where },
          {
            label: m.phase === Phase.Voided ? "Voided by" : "Settler",
            value: tx ? <AddressLink address={tx.by} full /> : loading ? "..." : "unknown",
          },
          ...source.items
            .filter((item) => item.label !== "Resolver")
            .map((item) => ({
              key: item.label,
              label: item.label,
              value: item.href ? (
                <a href={item.href} target="_blank" rel="noreferrer" className="mono">
                  {item.value}
                </a>
              ) : (
                <span className={item.mono ? "mono" : undefined}>{item.value}</span>
              ),
            })),
          { label: "Raw params", value: mono(m.params) },
        ]}
      />
    </Panel>
  );
}

function CheckPanel({
  m,
  result,
  running,
  error,
  onRun,
}: {
  m: MarketView;
  result: Verification | undefined;
  running: boolean;
  error: boolean;
  onRun: () => void;
}) {
  const expected = result && isCheckedRead(result.read) ? result.read.expectedHash : null;
  const settled = m.phase === Phase.Settled;
  return (
    <Panel title="Check it yourself" labelledBy="verify-rerun">
      <p className={v.lede}>
        The button sends the same eth_calls the resolver makes, from your browser to {appNetworkLabel}'s
        public RPC, with no wallet. It rebuilds the evidence hash from the values read, runs the resolver
        itself as a call, and compares both with what the market stored.
      </p>
      {result ? (
        <KeyValues
          items={[
            {
              label: "Evidence hash rebuilt",
              value: (
                <span className={v.compare}>
                  {mono(expected ?? "n/a")}
                  {settled ? <MatchBadge value={result.matches?.hash ?? null} /> : null}
                </span>
              ),
            },
            {
              label: "Resolver re-run",
              value: result.rerun ? (
                <span className={v.compare}>
                  {mono(`${OUTCOME[result.rerun.outcome]}, ${result.rerun.evidenceHash}`)}
                  {settled ? <MatchBadge value={result.matches?.resolver ?? null} /> : null}
                </span>
              ) : (
                (result.rerunError ?? "Nothing to run yet: there is no evidence that settles it.")
              ),
            },
            {
              label: "Outcome from the read",
              value: (
                <span className={v.compare}>
                  {isCheckedRead(result.read)
                    ? result.read.outcome === null
                      ? "n/a"
                      : OUTCOME[result.read.outcome]
                    : "n/a"}
                  {settled ? <MatchBadge value={result.matches?.outcome ?? null} /> : null}
                </span>
              ),
            },
            {
              label: "Ran",
              value: `${formatUtc(Math.floor(result.ranAt / 1000))} at block ${formatInt(result.headBlock)}, via ${result.rpc}`,
            },
          ]}
        />
      ) : null}
      {result?.mode === "preview" ? (
        <p className={v.note}>
          Preview: this market has not settled, so there is nothing stored to compare. This is what the read
          says now.
        </p>
      ) : null}
      {result?.mode === "voided" ? (
        <p className={v.note}>
          This market voided, so it stored no outcome. The read shows what the source says now.
        </p>
      ) : null}
      {error ? <p className={v.error}>The read failed. The RPC may be busy: try again.</p> : null}
      <div className={v.actions}>
        <Button variant="primary" onClick={onRun} disabled={running}>
          {running ? "Reading the chain..." : "Re-run this read from your browser"}
        </Button>
      </div>
    </Panel>
  );
}

export function VerifyBody({ m }: { m: MarketView }) {
  const final = m.phase === Phase.Settled || m.phase === Phase.Voided;
  const verification = useVerification(m);
  const settlement = useSettlementTx(m, final);
  const result = verification.data;
  return (
    <div className={v.stack}>
      <Panel title="Market" labelledBy="verify-market">
        <p className={v.headline}>
          <Link href={`/m/${m.address}`}>{marketHeadline(m)}</Link>
        </p>
        <KeyValues
          items={[
            { label: "Market", value: <AddressLink address={m.address} full /> },
            { label: "Phase", value: phaseLabel(m.phase) },
            { label: "Template", value: `${templateLabel(m.templateId)} (id ${m.templateId})` },
            { label: "Settlement deadline", value: formatUtc(m.window.settleDeadline) },
          ]}
        />
      </Panel>

      {final ? (
        <StoredPanel m={m} tx={settlement.data} loading={settlement.isPending} />
      ) : (
        <Notice tone="warn" title="Not settled yet">
          <p>
            This market is in phase "{phaseLabel(m.phase)}". Below is a preview: what the resolver's read says
            now. Once anyone settles it, this page also shows the stored outcome, the evidence hash, the
            settler and the transaction.
          </p>
        </Notice>
      )}

      {verification.isPending ? (
        <LoadingRows rows={2} label="Reading the source" />
      ) : result?.read.template === "perpl" ? (
        <PerplReadPanel read={result.read} m={m} />
      ) : result?.read.template === "chainlink" ? (
        <ChainlinkReadPanel read={result.read} tx={settlement.data} />
      ) : result?.read.template === "snapshot" ? (
        <SnapshotReadPanel read={result.read} />
      ) : result ? (
        <Panel title="The read" labelledBy="verify-read">
          <p className={v.lede}>
            {result.read.template === "pyth"
              ? "This market reads a signed Pyth price update, which the settle call carries. Re-running it needs that update from the settlement transaction and Pyth's fee, so this page shows the stored hash only."
              : "This app does not recognise the template, so it cannot rebuild the read."}
          </p>
        </Panel>
      ) : null}

      <CheckPanel
        m={m}
        result={result}
        running={verification.isFetching}
        error={verification.isError}
        onRun={() => void verification.refetch()}
      />
    </div>
  );
}

export function VerifyView({ address }: { address: Address }) {
  const query = useMarket(address);
  if (query.isPending) return <LoadingRows rows={2} label="Loading settlement" />;
  if (query.isError) {
    return <ErrorState title="Could not load this market" onRetry={() => void query.refetch()} />;
  }
  if (query.data.status === "not-deployed") return <NotDeployed willShow={VERIFY_WILL_SHOW} />;
  if (query.data.status === "not-market") {
    return (
      <EmptyState label="Not found" title="This address is not a Hunch Book market">
        <p>
          The factory on {appNetworkLabel} does not list <span className="mono">{address}</span>.
        </p>
      </EmptyState>
    );
  }
  return <VerifyBody m={query.data.data} />;
}
