"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { type Address, getAddress, isAddress } from "viem";
import { appDeployment, appNetwork, appNetworkLabel } from "@/lib/config";
import { usePerplPositions, usePerpMeta } from "@/lib/hedge/hooks";
import { lotsFromUnits, type PerpPosition, type PositionSide } from "@/lib/hedge/math";
import { hedgeId, loadHedges, type TrackedHedge, trackHedge, untrackHedge } from "@/lib/hedge/tracking";
import { useHedgePrefill } from "@/lib/hedge/usePrefill";
import { useChainClock, useMarkets } from "@/lib/hooks";
import { useAppChain } from "@/lib/wallet/useAppChain";
import ps from "../page.module.css";
import { EmptyState, ErrorState, LoadingRows } from "../states";
import { Button, Field, fieldA11y, Input, Notice, Panel, SegmentedControl } from "../ui";
import s from "./hedge.module.css";
import { type Horizon, PositionHedge, type RateBasis, type TrackRequest } from "./PositionHedge";
import { TrackedHedges } from "./TrackedHedges";

interface ManualEntry {
  key: string;
  position: PerpPosition;
}

/** The active network's Perpl perps (read on render: the network can be switched in the browser). */
const perpsOf = () =>
  Object.entries(appDeployment.external.perpl.perps).map(([symbol, id]) => ({ symbol, id: BigInt(id) }));

function ManualForm({ onAdd }: { onAdd: (position: PerpPosition) => void }) {
  const base = useId();
  const PERPS = perpsOf();
  const [perp, setPerp] = useState<string>(PERPS[0]?.id.toString() ?? "");
  const [side, setSide] = useState<PositionSide>("long");
  const [size, setSize] = useState("");
  const meta = usePerpMeta(perp ? BigInt(perp) : undefined);
  const units = Number(size);
  const valid = size.trim() !== "" && Number.isFinite(units) && units > 0;
  const add = () => {
    if (!valid || !meta.data) return;
    onAdd({
      perpId: BigInt(perp),
      side,
      lots: lotsFromUnits(units, meta.data),
      entryPricePNS: null,
      entryBlock: null,
      premiumPnlCNS: null,
      source: "manual",
    });
    setSize("");
  };
  const symbol = PERPS.find((p) => p.id.toString() === perp)?.symbol ?? "";
  return (
    <div className={s.manual}>
      <div>
        <label className={s.choiceLabel} htmlFor={`${base}-perp`}>
          Perp
        </label>
        <select
          id={`${base}-perp`}
          className={s.select}
          value={perp}
          onChange={(e) => setPerp(e.target.value)}
        >
          {PERPS.map((p) => (
            <option key={p.id.toString()} value={p.id.toString()}>
              {p.symbol} (perp {p.id.toString()})
            </option>
          ))}
        </select>
      </div>
      <div className={s.choice}>
        <span className={s.choiceLabel}>Side</span>
        <SegmentedControl<PositionSide>
          label="Position side"
          value={side}
          onChange={setSide}
          options={[
            { value: "long", label: "Long" },
            { value: "short", label: "Short" },
          ]}
        />
      </div>
      <Field id={`${base}-size`} label="Size">
        <Input
          {...fieldA11y(`${base}-size`)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.5"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          unit={symbol}
          mono
        />
      </Field>
      <Button onClick={add} disabled={!valid || !meta.data}>
        Add position
      </Button>
    </div>
  );
}

export function HedgeView() {
  const wallet = useAppChain();
  const ownerId = useId();
  const [ownerInput, setOwnerInput] = useState("");
  const [owner, setOwner] = useState<Address | undefined>(undefined);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualEntry[]>([]);
  const [horizon, setHorizon] = useState<Horizon>("day");
  const [basis, setBasis] = useState<RateBasis>("current");
  const [tracked, setTracked] = useState<TrackedHedge[]>([]);
  const [trackNote, setTrackNote] = useState<string | null>(null);

  const positions = usePerplPositions(owner);
  const markets = useMarkets();
  const clock = useChainClock();

  const addManual = useCallback(
    (position: PerpPosition) =>
      setManual((prev) => [...prev, { key: `${Date.now()}-${prev.length}`, position }]),
    [],
  );
  // A link such as /hedge?perp=BTC&side=long&size=0.5 (from the calculator) adds that position.
  useHedgePrefill(addManual);

  // Start from the connected wallet, once, if the person has not typed another address.
  useEffect(() => {
    if (wallet.address && ownerInput === "" && owner === undefined) {
      setOwnerInput(wallet.address);
      setOwner(wallet.address);
    }
  }, [wallet.address, ownerInput, owner]);

  useEffect(() => {
    setTracked(loadHedges(appNetwork));
  }, []);

  const readOwner = () => {
    const value = ownerInput.trim();
    if (!isAddress(value, { strict: false })) {
      setOwnerError("Enter a wallet address: 0x followed by 40 hex characters.");
      return;
    }
    setOwnerError(null);
    setOwner(getAddress(value));
  };

  const marketList = markets.data?.status === "ok" ? markets.data.data.markets : undefined;

  const trackedKeys = useMemo(
    () => new Set(tracked.map((t) => `${t.perpId}:${t.market.toLowerCase()}`)),
    [tracked],
  );

  const onTrack = useCallback((r: TrackRequest) => {
    if (!r.proposal.sizing.ok) return;
    const ok = trackHedge({
      id: hedgeId(),
      network: appNetwork,
      createdAt: Date.now(),
      perpId: r.position.perpId.toString(),
      symbol: r.meta.symbol,
      side: r.position.side,
      units: r.units,
      startBlock: r.startBlock.toString(),
      startSum: r.startSum.toString(),
      market: r.proposal.fm.market.address,
      buy: r.proposal.buy,
      mode: r.proposal.sizing.mode,
      cost: r.proposal.sizing.cost,
      tokens: r.proposal.sizing.tokens,
      payoutIfWin: r.proposal.sizing.payoutIfWin,
    });
    setTrackNote(
      ok
        ? "Tracking. It is listed under Tracked hedges below."
        : "This browser would not save it (private mode or full storage), so it cannot be tracked here.",
    );
    setTracked(loadHedges(appNetwork));
  }, []);

  const onRemoveTracked = (id: string) => {
    untrackHedge(id);
    setTracked(loadHedges(appNetwork));
  };

  const loaded = positions.data?.status === "ok" ? positions.data : null;
  const chainPositions = loaded ? loaded.positions.map((p, i) => ({ p, meta: loaded.metas[i] })) : [];

  return (
    <div className={ps.stack}>
      <Panel title="Your Perpl positions" labelledBy="hedge-input-title">
        <div className={s.controls}>
          <div className={s.ownerRow}>
            <div className={s.ownerField}>
              <Field
                id={ownerId}
                label="Wallet"
                hint={`Any address: the positions are read from Perpl's Exchange on ${appNetworkLabel}, with no wallet connection needed.`}
                error={ownerError ?? undefined}
              >
                <Input
                  {...fieldA11y(ownerId, { hint: true, error: Boolean(ownerError) })}
                  placeholder="0x..."
                  autoComplete="off"
                  spellCheck={false}
                  value={ownerInput}
                  onChange={(e) => setOwnerInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") readOwner();
                  }}
                  mono
                />
              </Field>
            </div>
            <Button variant="primary" onClick={readOwner}>
              Read positions
            </Button>
          </div>
          <div className={s.choices}>
            <div className={s.choice}>
              <span className={s.choiceLabel}>Project funding over</span>
              <SegmentedControl<Horizon>
                label="Projection window"
                size="sm"
                value={horizon}
                onChange={setHorizon}
                options={[
                  { value: "day", label: "Next 24 hours" },
                  { value: "week", label: "Next 7 days" },
                ]}
              />
            </div>
            <div className={s.choice}>
              <span className={s.choiceLabel}>At the rate of</span>
              <SegmentedControl<RateBasis>
                label="Funding rate used"
                size="sm"
                value={basis}
                onChange={setBasis}
                options={[
                  { value: "current", label: "the last interval" },
                  { value: "average", label: "the last 24 hours" },
                ]}
              />
            </div>
          </div>
          <details>
            <summary className={s.note} style={{ cursor: "pointer" }}>
              Or enter a position by hand
            </summary>
            <div style={{ marginTop: 12 }}>
              <ManualForm onAdd={addManual} />
            </div>
          </details>
        </div>
      </Panel>

      {trackNote ? (
        <Notice tone="accent" role="status">
          {trackNote}
        </Notice>
      ) : null}

      <div className={s.positions}>
        {owner && positions.isPending ? <LoadingRows rows={2} label="Reading positions from Perpl" /> : null}
        {owner && positions.isError ? (
          <ErrorState title="Could not read positions from Perpl" onRetry={() => void positions.refetch()} />
        ) : null}
        {owner && positions.data?.status === "no-account" ? (
          <EmptyState title="No Perpl account for this address" glyph="search">
            <p>
              Perpl's Exchange on {appNetworkLabel} has no account for this address. Check the address, or
              enter a position by hand above.
            </p>
          </EmptyState>
        ) : null}
        {owner && positions.data?.status === "ok" && positions.data.positions.length === 0 ? (
          <EmptyState title="No open Perpl positions" glyph="search">
            <p>This Perpl account holds no open position right now. You can enter one by hand above.</p>
          </EmptyState>
        ) : null}
        {chainPositions.map(({ p, meta }) => (
          <PositionHedge
            key={`chain-${p.perpId.toString()}`}
            position={p}
            metaHint={meta}
            horizon={horizon}
            basis={basis}
            markets={marketList}
            clock={clock}
            onTrack={onTrack}
            trackedMarkets={trackedKeys}
          />
        ))}
        {manual.map((entry) => (
          <PositionHedge
            key={entry.key}
            position={entry.position}
            horizon={horizon}
            basis={basis}
            markets={marketList}
            clock={clock}
            onTrack={onTrack}
            trackedMarkets={trackedKeys}
            onRemove={() => setManual((prev) => prev.filter((m) => m.key !== entry.key))}
          />
        ))}
        {!owner && manual.length === 0 ? (
          <EmptyState title="Start with a wallet or a position" glyph="search">
            <p>
              Enter the wallet that trades on Perpl, or connect it, and press Read positions. Or enter a
              position by hand.
            </p>
          </EmptyState>
        ) : null}
      </div>

      {tracked.length > 0 ? (
        <Panel title="Tracked hedges" labelledBy="hedge-tracked-title">
          <TrackedHedges hedges={tracked} onRemove={onRemoveTracked} />
        </Panel>
      ) : null}
    </div>
  );
}
