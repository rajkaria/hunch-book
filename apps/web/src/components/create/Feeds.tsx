"use client";

import { PriceSource } from "@hunch-book/shared";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { usePriceFeeds } from "@/lib/create/hooks";
import { type PriceFeedOption, sourceName } from "@/lib/create/price";
import type { SpotPrice } from "@/lib/create/reads";
import { formatDuration, formatE8Usd } from "@/lib/format";
import { Button, Notice, Panel, SegmentedControl, Skeleton } from "../ui";
import s from "./create.module.css";

/** Reads the feeds a price resolver accepts, then renders the form with them. */
export function FeedsGate({
  resolver,
  children,
}: {
  resolver: Address;
  children: (options: PriceFeedOption[]) => ReactNode;
}) {
  const feeds = usePriceFeeds(resolver);
  if (feeds.isError) {
    return (
      <Panel title="Step 2: parameters" labelledBy="params-title">
        <Notice tone="danger" title="Could not read the price feeds" role="alert">
          <p>The RPC did not answer for the resolver's list of feeds. Nothing was sent.</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => void feeds.refetch()}>
              Try again
            </Button>
          </div>
        </Notice>
      </Panel>
    );
  }
  if (!feeds.data) {
    return (
      <Panel title="Step 2: parameters" labelledBy="params-title">
        <div className={s.fields} role="status">
          <span className="visually-hidden">Reading the price feeds</span>
          <Skeleton width="100%" height={44} />
          <Skeleton width="60%" height={44} />
        </div>
      </Panel>
    );
  }
  if (feeds.data.length === 0) {
    return (
      <Panel title="Step 2: parameters" labelledBy="params-title">
        <Notice tone="warn" title="No feeds">
          <p>This template's resolver accepts no price feeds on this network yet.</p>
        </Notice>
      </Panel>
    );
  }
  return <>{children(feeds.data)}</>;
}

/** The feed choice, with the feed's current price under it. */
export function FeedPicker({
  options,
  value,
  onChange,
  option,
  spot,
  spotFailed,
  now,
  error,
}: {
  options: readonly PriceFeedOption[];
  value: string;
  onChange: (key: string) => void;
  option: PriceFeedOption | null;
  spot: SpotPrice | null | undefined;
  spotFailed: boolean;
  now: number;
  error?: string;
}) {
  return (
    <div>
      <span className={s.groupLabel}>Price feed</span>
      <SegmentedControl
        label="Price feed"
        name="price-feed"
        block
        value={value}
        onChange={onChange}
        options={options.map((o) => ({
          value: o.key,
          label: o.asset,
          detail: sourceName(o.source),
        }))}
      />
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
      {option ? (
        <p className={s.small} style={{ marginTop: 8 }}>
          {spot ? (
            <>
              {option.label} now: <span className={s.mono}>{formatE8Usd(spot.priceE8)}</span> on{" "}
              {sourceName(option.source)}, last updated {formatDuration(Math.max(0, now - spot.updatedAt))}{" "}
              ago.
            </>
          ) : spotFailed || spot === null ? (
            "Could not read the current price."
          ) : (
            "Reading the current price..."
          )}
          {option.source === PriceSource.Pyth
            ? " Chainlink has no feed for this asset on this network, so the market settles from Pyth."
            : ""}
        </p>
      ) : null}
    </div>
  );
}
