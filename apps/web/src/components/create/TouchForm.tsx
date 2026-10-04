"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  buildTouchParams,
  defaultTouchDraft,
  type FormResult,
  issueFor,
  TOUCH_CHALLENGE_SECONDS,
  type TouchDraft,
} from "@/lib/create/build";
import { fromLocalInput } from "@/lib/create/clock";
import { useSpotPrice } from "@/lib/create/hooks";
import { type TouchLinked, toExactLocalInput } from "@/lib/create/linked";
import { type PriceFeedOption, touchLevel } from "@/lib/create/price";
import { toInputString } from "@/lib/create/units";
import { formatE8Usd } from "@/lib/format";
import { Button, Field, fieldA11y, Input, Panel, SegmentedControl } from "../ui";
import s from "./create.module.css";
import { FeedPicker, FeedsGate } from "./Feeds";
import { When } from "./When";

/** Step 2 for template 3: does a Chainlink feed reach (or fall to) a level at any time in a window. */
export function TouchForm({
  now,
  resolver,
  onResult,
  linked,
}: {
  now: number;
  resolver: Address;
  onResult: (r: FormResult) => void;
  /** A market's exact params from a link (lib/create/linked.ts), for example a ladder's missing strike. */
  linked?: TouchLinked;
}) {
  return (
    <FeedsGate resolver={resolver}>
      {(options) => <TouchFields now={now} options={options} onResult={onResult} linked={linked} />}
    </FeedsGate>
  );
}

/** The draft a link describes, on top of the defaults. A feed this resolver does not list is left out. */
function linkedTouchDraft(
  base: TouchDraft,
  linked: TouchLinked,
  options: readonly PriceFeedOption[],
): TouchDraft {
  return {
    ...base,
    feed: options.some((o) => o.key === linked.feedKey) ? linked.feedKey : base.feed,
    direction: linked.direction,
    strike: toInputString(linked.strikeE8, 8),
    start: toExactLocalInput(linked.startTime),
    end: toExactLocalInput(linked.endTime),
    lockAtStart: linked.lockTime === linked.startTime,
    lock: toExactLocalInput(linked.lockTime),
  };
}

function TouchFields({
  now,
  options,
  onResult,
  linked,
}: {
  now: number;
  options: PriceFeedOption[];
  onResult: (r: FormResult) => void;
  linked?: TouchLinked;
}) {
  const [draft, setDraft] = useState<TouchDraft>(() =>
    linked
      ? linkedTouchDraft(defaultTouchDraft(now, options), linked, options)
      : defaultTouchDraft(now, options),
  );
  const [strikeTouched, setStrikeTouched] = useState(linked !== undefined);
  const set = (patch: Partial<TouchDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const build = buildTouchParams(draft, { options, now });
  const option = build.option;
  const spot = useSpotPrice(option);
  const suggested = spot.data ? touchLevel(spot.data.priceE8, draft.direction) : null;
  const suggestedText = suggested !== null ? toInputString(suggested, 8) : null;

  // Until the creator types a level, start 5% away from the current price in the chosen direction.
  useEffect(() => {
    if (strikeTouched || suggestedText === null) return;
    setDraft((d) => (d.strike === suggestedText ? d : { ...d, strike: suggestedText }));
  }, [suggestedText, strikeTouched]);

  const params = build.params;
  const challengeUnix = build.endTime !== null ? build.endTime + TOUCH_CHALLENGE_SECONDS : null;
  useEffect(() => {
    onResult({
      params,
      clock: null,
      priceSource: null,
      challengeEnd: challengeUnix !== null ? { block: null, unix: challengeUnix } : null,
    });
  }, [params, challengeUnix, onResult]);

  const feedError = issueFor(build.issues, "feed");
  const strikeError = issueFor(build.issues, "strike");
  const startError = issueFor(build.issues, "start");
  const endError = issueFor(build.issues, "end");
  const lockError = issueFor(build.issues, "lock");
  const start = fromLocalInput(draft.start);
  const end = fromLocalInput(draft.end);
  const lock = draft.lockAtStart ? start : fromLocalInput(draft.lock);
  const pair = option?.label ?? "the feed";
  const verb = draft.direction === "above" ? "at or above" : "at or below";

  return (
    <Panel title="Step 2: parameters" labelledBy="params-title">
      <div className={s.fields}>
        <FeedPicker
          options={options}
          value={draft.feed}
          onChange={(feed) => {
            setStrikeTouched(false);
            set({ feed, strike: "" });
          }}
          option={option}
          spot={spot.data}
          spotFailed={spot.isError}
          now={now}
          error={feedError}
        />

        <div>
          <span className={s.groupLabel}>Direction</span>
          <SegmentedControl
            label="Direction"
            name="touch-direction"
            block
            value={draft.direction}
            onChange={(direction) => {
              setStrikeTouched(false);
              set({ direction });
            }}
            options={[
              { value: "above", label: "Reaches", detail: "at or above" },
              { value: "below", label: "Falls to", detail: "at or below" },
            ]}
          />
        </div>

        <div>
          <Field
            id="touch-strike"
            label="Price level, in USD"
            hint={`YES if Chainlink's ${pair} feed reports a price ${verb} this in any round inside the window. Exactly equal counts.`}
            error={strikeError}
          >
            <Input
              mono
              inputMode="decimal"
              autoComplete="off"
              unit="USD"
              value={draft.strike}
              onChange={(e) => {
                setStrikeTouched(true);
                set({ strike: e.target.value });
              }}
              {...fieldA11y("touch-strike", { hint: true, error: Boolean(strikeError) })}
            />
          </Field>
          {suggested !== null ? (
            <div className={s.quick} style={{ marginTop: 8 }}>
              <Button
                size="sm"
                onClick={() => {
                  setStrikeTouched(false);
                  set({ strike: toInputString(suggested, 8) });
                }}
              >
                Use 5% {draft.direction === "above" ? "above" : "below"} now: {formatE8Usd(suggested)}
              </Button>
            </div>
          ) : null}
        </div>

        <div className={s.row}>
          <Field
            id="touch-start"
            label="Window starts"
            hint={start !== null ? <When unix={start} /> : "The first moment a round counts."}
            error={startError}
          >
            <Input
              type="datetime-local"
              value={draft.start}
              onChange={(e) => set({ start: e.target.value })}
              {...fieldA11y("touch-start", { hint: true, error: Boolean(startError) })}
            />
          </Field>
          <Field
            id="touch-end"
            label="Window ends (close)"
            hint={
              end !== null ? (
                <>
                  <When unix={end} />
                  <span className={s.estimate}>
                    NO can settle 24 hours later if nobody has proved a touch. At most 31 days after the
                    start.
                  </span>
                </>
              ) : (
                "The last moment a round counts."
              )
            }
            error={endError}
          >
            <Input
              type="datetime-local"
              value={draft.end}
              onChange={(e) => set({ end: e.target.value })}
              {...fieldA11y("touch-end", { hint: true, error: Boolean(endError) })}
            />
          </Field>
        </div>

        <label className={s.check}>
          <input
            type="checkbox"
            checked={draft.lockAtStart}
            onChange={(e) => set({ lockAtStart: e.target.checked, lock: draft.start })}
          />
          <span className={s.checkText}>
            <span>Stop staking when the window starts</span>
            <span className={s.small}>
              Staking must stop at or before the first moment a round can count. Untick to stop it earlier.
            </span>
          </span>
        </label>
        {draft.lockAtStart ? (
          lockError ? (
            <p className={s.error} role="alert">
              {lockError}
            </p>
          ) : null
        ) : (
          <Field
            id="touch-lock"
            label="Lock: when staking stops"
            hint={lock !== null ? <When unix={lock} /> : "Pick a date and time."}
            error={lockError}
          >
            <Input
              type="datetime-local"
              value={draft.lock}
              onChange={(e) => set({ lock: e.target.value })}
              {...fieldA11y("touch-lock", { hint: true, error: Boolean(lockError) })}
            />
          </Field>
        )}
      </div>
    </Panel>
  );
}
