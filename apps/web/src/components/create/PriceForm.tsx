"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  buildPriceParams,
  defaultPriceDraft,
  type FormResult,
  issueFor,
  type PriceDraft,
  type PriceRule,
  priceLockTime,
} from "@/lib/create/build";
import { fromLocalInput, toLocalInput } from "@/lib/create/clock";
import { useSpotPrice } from "@/lib/create/hooks";
import { lockLeadOf, type PriceLinked, toExactLocalInput } from "@/lib/create/linked";
import { type LockLead, type PriceFeedOption, rangeAround } from "@/lib/create/price";
import { roundSignificant, toInputString } from "@/lib/create/units";
import { formatE8Usd } from "@/lib/format";
import { Button, Field, fieldA11y, Input, Panel, SegmentedControl } from "../ui";
import s from "./create.module.css";
import { FeedPicker, FeedsGate } from "./Feeds";
import { When } from "./When";

const LEADS: { value: LockLead; label: string }[] = [
  { value: "day", label: "24 hours before" },
  { value: "hour", label: "1 hour before" },
  { value: "custom", label: "Custom" },
];

/**
 * Step 2 for the price templates: at or above one level at a set time (template 2, rule "at"), or
 * between two levels at a set time (template 5, rule "range").
 */
export function PriceForm({
  now,
  rule,
  resolver,
  onResult,
  linked,
}: {
  now: number;
  rule: PriceRule;
  resolver: Address;
  onResult: (r: FormResult) => void;
  /** A market's exact params from a link (lib/create/linked.ts), for example a ladder's missing strike. */
  linked?: PriceLinked;
}) {
  return (
    <FeedsGate resolver={resolver}>
      {(options) => (
        <PriceFields now={now} rule={rule} options={options} onResult={onResult} linked={linked} />
      )}
    </FeedsGate>
  );
}

/** The draft a link describes, on top of the defaults. A feed this resolver does not list is left out. */
function linkedPriceDraft(
  base: PriceDraft,
  linked: PriceLinked,
  options: readonly PriceFeedOption[],
): PriceDraft {
  const lead = lockLeadOf(linked.lockTime, linked.closeTime);
  return {
    ...base,
    feed: options.some((o) => o.key === linked.feedKey) ? linked.feedKey : base.feed,
    strike: linked.strikeE8 !== null ? toInputString(linked.strikeE8, 8) : base.strike,
    lower: linked.lowerE8 !== null ? toInputString(linked.lowerE8, 8) : base.lower,
    upper: linked.upperE8 !== null ? toInputString(linked.upperE8, 8) : base.upper,
    close: toExactLocalInput(linked.closeTime),
    lockLead: lead,
    lock: toExactLocalInput(linked.lockTime),
  };
}

function PriceFields({
  now,
  rule,
  options,
  onResult,
  linked,
}: {
  now: number;
  rule: PriceRule;
  options: PriceFeedOption[];
  onResult: (r: FormResult) => void;
  linked?: PriceLinked;
}) {
  const [draft, setDraft] = useState<PriceDraft>(() =>
    linked
      ? linkedPriceDraft(defaultPriceDraft(now, options), linked, options)
      : defaultPriceDraft(now, options),
  );
  const [levelsTouched, setLevelsTouched] = useState(linked !== undefined);
  const set = (patch: Partial<PriceDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const build = buildPriceParams(draft, { options, now, rule });
  const option = build.option;
  const spot = useSpotPrice(option);
  const spotE8 = spot.data?.priceE8 ?? null;
  const suggestedStrike = spotE8 !== null ? roundSignificant(spotE8, 3) : null;
  const suggestedRange = spotE8 !== null ? rangeAround(spotE8) : null;
  const strikeText = suggestedStrike !== null ? toInputString(suggestedStrike, 8) : null;
  const lowerText = suggestedRange ? toInputString(suggestedRange.lower, 8) : null;
  const upperText = suggestedRange ? toInputString(suggestedRange.upper, 8) : null;

  // Until the creator types a level, start from the current price, rounded.
  useEffect(() => {
    if (levelsTouched) return;
    if (rule === "at" && strikeText !== null) {
      setDraft((d) => (d.strike === strikeText ? d : { ...d, strike: strikeText }));
    }
    if (rule === "range" && lowerText !== null && upperText !== null) {
      setDraft((d) =>
        d.lower === lowerText && d.upper === upperText ? d : { ...d, lower: lowerText, upper: upperText },
      );
    }
  }, [rule, strikeText, lowerText, upperText, levelsTouched]);

  const params = build.params;
  const source = option?.source ?? null;
  useEffect(() => {
    onResult({ params, clock: null, priceSource: source, challengeEnd: null });
  }, [params, source, onResult]);

  const feedError = issueFor(build.issues, "feed");
  const strikeError = issueFor(build.issues, "strike");
  const lowerError = issueFor(build.issues, "lower");
  const upperError = issueFor(build.issues, "upper");
  const closeError = issueFor(build.issues, "close");
  const lockError = issueFor(build.issues, "lock");
  const closeTime = fromLocalInput(draft.close);
  const lockTime = priceLockTime(draft, closeTime);
  const pair = option?.label ?? "the price";

  return (
    <Panel title="Step 2: parameters" labelledBy="params-title">
      <div className={s.fields}>
        <FeedPicker
          options={options}
          value={draft.feed}
          onChange={(feed) => {
            setLevelsTouched(false);
            set({ feed, strike: "", lower: "", upper: "" });
          }}
          option={option}
          spot={spot.data}
          spotFailed={spot.isError}
          now={now}
          error={feedError}
        />

        {rule === "at" ? (
          <div>
            <Field
              id="price-strike"
              label="Price level (strike), in USD"
              hint={`YES if ${pair} is at or above this at the close. Below it is NO.`}
              error={strikeError}
            >
              <Input
                mono
                inputMode="decimal"
                autoComplete="off"
                unit="USD"
                value={draft.strike}
                onChange={(e) => {
                  setLevelsTouched(true);
                  set({ strike: e.target.value });
                }}
                {...fieldA11y("price-strike", { hint: true, error: Boolean(strikeError) })}
              />
            </Field>
            {suggestedStrike !== null ? (
              <div className={s.quick} style={{ marginTop: 8 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    setLevelsTouched(false);
                    set({ strike: toInputString(suggestedStrike, 8) });
                  }}
                >
                  Use the current price: {formatE8Usd(suggestedStrike)}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div>
            <div className={s.row}>
              <Field
                id="price-lower"
                label="Bottom of the range, in USD"
                hint="Included: exactly this price is inside."
                error={lowerError}
              >
                <Input
                  mono
                  inputMode="decimal"
                  autoComplete="off"
                  unit="USD"
                  value={draft.lower}
                  onChange={(e) => {
                    setLevelsTouched(true);
                    set({ lower: e.target.value });
                  }}
                  {...fieldA11y("price-lower", { hint: true, error: Boolean(lowerError) })}
                />
              </Field>
              <Field
                id="price-upper"
                label="Top of the range, in USD"
                hint="Not included: exactly this price is outside."
                error={upperError}
              >
                <Input
                  mono
                  inputMode="decimal"
                  autoComplete="off"
                  unit="USD"
                  value={draft.upper}
                  onChange={(e) => {
                    setLevelsTouched(true);
                    set({ upper: e.target.value });
                  }}
                  {...fieldA11y("price-upper", { hint: true, error: Boolean(upperError) })}
                />
              </Field>
            </div>
            <p className={s.small} style={{ marginTop: 8 }}>
              YES if {pair} is at or above the bottom and below the top at the close. Ranges that share a
              bound never both settle YES.
            </p>
            {suggestedRange !== null ? (
              <div className={s.quick} style={{ marginTop: 8 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    setLevelsTouched(false);
                    set({
                      lower: toInputString(suggestedRange.lower, 8),
                      upper: toInputString(suggestedRange.upper, 8),
                    });
                  }}
                >
                  Use 2% either side of now: {formatE8Usd(suggestedRange.lower)} to{" "}
                  {formatE8Usd(suggestedRange.upper)}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        <Field
          id="price-close"
          label="Close: when the price is read"
          hint={closeTime !== null ? <When unix={closeTime} /> : "Pick a date and time."}
          error={closeError}
        >
          <Input
            type="datetime-local"
            value={draft.close}
            onChange={(e) => set({ close: e.target.value })}
            {...fieldA11y("price-close", { hint: true, error: Boolean(closeError) })}
          />
        </Field>

        <div>
          <span className={s.groupLabel}>Lock: when staking stops</span>
          <SegmentedControl
            label="When staking stops"
            name="price-lock"
            block
            size="sm"
            value={draft.lockLead}
            onChange={(lockLead) =>
              set({
                lockLead,
                lock: lockLead === "custom" && lockTime !== null ? toLocalInput(lockTime) : draft.lock,
              })
            }
            options={LEADS}
          />
          {draft.lockLead === "custom" ? (
            <div style={{ marginTop: 12 }}>
              <Field
                id="price-lock"
                label="Lock time"
                hint={lockTime !== null ? <When unix={lockTime} /> : "Pick a date and time."}
                error={lockError}
              >
                <Input
                  type="datetime-local"
                  value={draft.lock}
                  onChange={(e) => set({ lock: e.target.value })}
                  {...fieldA11y("price-lock", { hint: true, error: Boolean(lockError) })}
                />
              </Field>
            </div>
          ) : (
            <p className={s.small} style={{ marginTop: 8 }}>
              {lockTime !== null ? (
                <>
                  Staking stops <When unix={lockTime} />
                </>
              ) : null}
              Daily markets lock 24 hours before the close and intraday ones 1 hour before, so nobody can
              stake once the answer is close to known.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
