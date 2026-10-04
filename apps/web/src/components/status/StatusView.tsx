"use client";

import { addressUrl, PHASE_LABEL, type Phase, txUrl } from "@hunch-book/shared";
import Link from "next/link";
import type { Address, Hex } from "viem";
import { appDeployment, appNetworkLabel, isDeployed } from "@/lib/config";
import { formatUsdc, formatUtc, shortAddress } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import {
  checkService,
  duration,
  evaluateChain,
  type Level,
  obligationsBreakdown,
  overall,
  PHASE,
  type StatusCheck,
  supplyProblem,
} from "@/lib/status/checks";
import type { ServiceHealthView } from "@/lib/status/health";
import { useIndexerLifecycle, useServiceHealth, useStatusSnapshot } from "@/lib/status/hooks";
import type { Block } from "@/lib/status/incidents";
import { type LastEvent, lifecycleFromKeeper } from "@/lib/status/lifecycle";
import type { StatusSnapshot } from "@/lib/status/reads";
import ps from "../page.module.css";
import { ErrorState, LoadingRows, NotDeployed } from "../states";
import { AddressLink, Badge, KeyValues, Panel, Stat, type Tone } from "../ui";
import { ContractLinks } from "./ContractLinks";
import { Incidents } from "./Incidents";
import s from "./status.module.css";

const TONE: Record<Level, Tone> = { ok: "accent", warn: "warn", fail: "danger", unknown: "muted" };
const WORD: Record<Level, string> = { ok: "OK", warn: "Attention", fail: "Problem", unknown: "Not known" };
const HEADLINE: Record<Level, string> = {
  ok: "All checks pass",
  warn: "Something needs attention",
  fail: "A check is failing",
  unknown: "Checking",
};

export function LevelBadge({ level }: { level: Level }) {
  return (
    <Badge tone={TONE[level]} dot>
      {WORD[level]}
    </Badge>
  );
}

function CheckList({ checks }: { checks: StatusCheck[] }) {
  return (
    <ul className={s.checks}>
      {checks.map((c) => (
        <li key={c.id} className={s.check}>
          <span>
            <LevelBadge level={c.level} />
          </span>
          <div>
            <p className={s.checkTitle}>{c.title}</p>
            <p className={s.checkSummary}>{c.summary}</p>
            {c.details && c.details.length > 0 ? (
              <ul className={s.details}>
                {c.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

const ago = (unix: number, now: number | null) => (now === null ? "" : ` (${duration(now - unix)} ago)`);

function EventLine({
  label,
  e,
  now,
}: {
  label: string;
  e: LastEvent | null | undefined;
  now: number | null;
}) {
  if (!e) return <span className="muted">{label}: not known yet</span>;
  return (
    <span>
      {formatUtc(e.at)}
      {ago(e.at, now)}
      {e.market ? (
        <>
          {" "}
          · <Link href={`/m/${e.market}`}>market {shortAddress(e.market)}</Link>
        </>
      ) : null}
      {e.tx && /^0x[0-9a-fA-F]{64}$/.test(e.tx) ? (
        <>
          {" "}
          ·{" "}
          <a href={txUrl(appDeployment, e.tx as Hex)} target="_blank" rel="noreferrer">
            transaction
          </a>
        </>
      ) : null}{" "}
      <span className="subtle">(from {e.source === "indexer" ? "the indexer" : "the keeper's health"})</span>
    </span>
  );
}

function ServicePanel({
  name,
  address,
  balance,
  health,
  now,
}: {
  name: "keeper" | "maker";
  address: Address;
  balance: bigint | undefined;
  health: ServiceHealthView | undefined;
  now: number | null;
}) {
  const check = checkService(name, health, now ?? Math.floor(Date.now() / 1000));
  const last = health?.jobs
    ? Object.entries(health.jobs)
        .flatMap(([job, j]) => (j.lastAction?.at ? [{ job, ...j.lastAction }] : []))
        .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""))[0]
    : undefined;
  return (
    <Panel
      title={name === "keeper" ? "Keeper (ours)" : "Maker bot (ours)"}
      aside={<LevelBadge level={check.level} />}
    >
      <KeyValues
        items={[
          { label: "Address", value: <AddressLink address={address} /> },
          {
            label: "MON on chain",
            value:
              balance === undefined
                ? "..."
                : `${(Number(balance) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 3 })} MON`,
          },
          { label: "Health", value: check.summary },
          ...(health?.lastCycleAt ? [{ label: "Last cycle", value: health.lastCycleAt }] : []),
          ...(name === "maker" && health?.lastQuoteAt
            ? [{ label: "Last quote", value: health.lastQuoteAt }]
            : []),
          ...(name === "maker" && health?.openOrders !== undefined
            ? [{ label: "Open orders", value: String(health.openOrders) }]
            : []),
          ...(last
            ? [
                {
                  label: "Last action",
                  value: (
                    <span>
                      {last.job}: {last.action} {last.status}
                      {last.url ? (
                        <>
                          {" "}
                          <a href={last.url} target="_blank" rel="noreferrer">
                            transaction
                          </a>
                        </>
                      ) : null}{" "}
                      <span className="subtle">{last.at}</span>
                    </span>
                  ),
                },
              ]
            : []),
          ...(health?.lastError ? [{ label: "Last error", value: health.lastError }] : []),
          ...(health?.enabled === false ? [{ label: "Mode", value: "dry run: decides, sends nothing" }] : []),
        ]}
      />
    </Panel>
  );
}

function MarketsTable({ snapshot }: { snapshot: StatusSnapshot }) {
  if (snapshot.markets.length === 0) return <p className="muted">No markets yet.</p>;
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Phase</th>
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
            <th scope="col">Supply check</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.markets.map((m) => {
            const problem = supplyProblem(m);
            const before = m.graduated && m.phase !== PHASE.Settled && m.phase !== PHASE.Voided;
            return (
              <tr key={m.address}>
                <td>
                  <Link href={`/m/${m.address}`}>#{m.marketId.toString()}</Link>{" "}
                  <a
                    className="subtle"
                    href={addressUrl(appDeployment, m.address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(m.address)}
                  </a>
                </td>
                <td>{PHASE_LABEL[m.phase as Phase] ?? m.phase}</td>
                <td className={s.num}>{formatUsdc(m.ledger.pool)}</td>
                <td className={s.num}>{formatUsdc(m.ledger.sets)}</td>
                <td className={s.num}>{formatUsdc(m.yesSupply)}</td>
                <td className={s.num}>{formatUsdc(m.noSupply)}</td>
                <td>
                  {problem ? (
                    <LevelBadge level="fail" />
                  ) : before ? (
                    <LevelBadge level="ok" />
                  ) : (
                    <span className="subtle">
                      {m.graduated ? "settled: sets are owed to winners" : "pool: no tokens"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StatusView({ incidents }: { incidents: Block[] }) {
  const snapshot = useStatusSnapshot();
  const keeper = useServiceHealth("keeper");
  const maker = useServiceHealth("maker");
  const indexer = useIndexerLifecycle();
  const now = useNow(15_000);

  if (!isDeployed(appDeployment)) return <NotDeployed />;

  const data = snapshot.data;
  const chainChecks = data ? evaluateChain(data) : [];
  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  const serviceChecks = [
    ...(keeper.data ? [checkService("keeper", keeper.data, nowSeconds)] : []),
    ...(maker.data ? [checkService("maker", maker.data, nowSeconds)] : []),
  ];
  const checks = data ? [...chainChecks, ...serviceChecks] : [];
  const level: Level = data ? overall(checks) : snapshot.isError ? "fail" : "unknown";
  const lifecycle = indexer.data ?? lifecycleFromKeeper(keeper.data);
  const breakdown = data ? obligationsBreakdown(data) : null;

  return (
    <div className={ps.stack}>
      <Panel title={HEADLINE[level]} aside={<LevelBadge level={level} />} labelledBy="status-overall-title">
        {snapshot.isPending ? (
          <LoadingRows rows={3} label={`Reading ${appNetworkLabel}`} />
        ) : snapshot.isError || !data ? (
          <ErrorState title="Could not read the contracts" onRetry={() => void snapshot.refetch()} />
        ) : (
          <>
            <p className={s.note} style={{ marginBottom: 12 }}>
              Read live from {appNetworkLabel} at block {data.block.toLocaleString("en-US")} (
              {formatUtc(data.timestamp)}). Every number comes from the contracts listed below; it refreshes
              every 15 seconds.
            </p>
            <CheckList checks={checks} />
          </>
        )}
      </Panel>

      {data && breakdown ? (
        <Panel title="Money in the vault" labelledBy="status-money-title">
          <div className={s.figures}>
            <Stat
              label="USDC held"
              value={formatUsdc(data.vault.balance)}
              source={{ href: addressUrl(appDeployment, data.vault.address), label: "vault", external: true }}
            />
            <Stat label="Owed (total obligations)" value={formatUsdc(data.vault.totalObligations)} />
            <Stat
              label="Surplus"
              value={formatUsdc(data.vault.surplus)}
              tone={data.vault.surplus < 0n ? "no" : "accent"}
              hint="must be zero or more"
            />
            <Stat label="In pools" value={formatUsdc(breakdown.pools)} />
            <Stat label="Backing tokens (complete sets)" value={formatUsdc(breakdown.sets)} />
            <Stat
              label="Collateral cap"
              value={formatUsdc(data.vault.collateralCap)}
              hint={`${formatUsdc(data.vault.totalCollateral)} counted toward it`}
            />
            <Stat label="Protocol fees (unwithdrawn)" value={formatUsdc(data.vault.protocolFees)} />
            <Stat
              label="Creator fees (unwithdrawn)"
              value={formatUsdc(breakdown.creatorFees)}
              hint={`${data.creatorFees.length} creator${data.creatorFees.length === 1 ? "" : "s"}`}
            />
          </div>
        </Panel>
      ) : null}

      {data ? (
        <Panel title="Markets" labelledBy="status-markets-title">
          <MarketsTable snapshot={data} />
          {data.partial ? (
            <p className={s.note}>
              Showing the first {data.markets.length} of {data.factory.marketCount} markets.
            </p>
          ) : null}
        </Panel>
      ) : null}

      <div className={s.services}>
        <ServicePanel
          name="keeper"
          address={appDeployment.wallets.keeper}
          balance={data?.wallets.keeper}
          health={keeper.data}
          now={now}
        />
        <ServicePanel
          name="maker"
          address={appDeployment.wallets.maker}
          balance={data?.wallets.maker}
          health={maker.data}
          now={now}
        />
      </div>

      <Panel title="Last settlement and graduation" labelledBy="status-lifecycle-title">
        <KeyValues
          items={[
            {
              label: "Last settlement",
              value: <EventLine label="Last settlement" e={lifecycle?.settlement} now={now} />,
            },
            {
              label: "Last graduation",
              value: <EventLine label="Last graduation" e={lifecycle?.graduation} now={now} />,
            },
          ]}
        />
        {!lifecycle ? (
          <p className={s.note} style={{ marginTop: 8 }}>
            These come from the indexer (NEXT_PUBLIC_INDEXER_URL) or the keeper's health; neither is set up
            for this site yet.
          </p>
        ) : null}
      </Panel>

      {data ? (
        <Panel title="Guardian and roles" labelledBy="status-roles-title">
          <KeyValues
            items={[
              { label: "Guardian", value: <AddressLink address={data.factory.guardian} full /> },
              { label: "Fee recipient", value: <AddressLink address={data.factory.feeRecipient} full /> },
              { label: "Creating markets", value: data.factory.creationPaused ? "paused" : "open" },
              { label: "Graduation", value: data.factory.graduationPaused ? "paused" : "open" },
              { label: "Settlement and redemption", value: "always open: the guardian cannot pause them" },
            ]}
          />
        </Panel>
      ) : null}

      <Panel title="Incident log" labelledBy="status-incidents-title">
        <Incidents blocks={incidents} />
      </Panel>

      <Panel title="Every contract" labelledBy="status-contracts-title">
        <ContractLinks deployment={appDeployment} />
      </Panel>
    </div>
  );
}
