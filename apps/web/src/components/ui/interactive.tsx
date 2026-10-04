"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import s from "./ui.module.css";

const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");

/** Moves focus between enabled items with the arrow keys, Home and End. Returns the new index or null. */
function nextIndex(key: string, current: number, enabled: boolean[]): number | null {
  const count = enabled.length;
  if (count === 0) return null;
  const step = (from: number, dir: 1 | -1): number => {
    for (let i = 1; i <= count; i++) {
      const at = (from + dir * i + count) % count;
      if (enabled[at]) return at;
    }
    return from;
  };
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return step(current, 1);
    case "ArrowLeft":
    case "ArrowUp":
      return step(current, -1);
    case "Home":
      return enabled.indexOf(true);
    case "End":
      return enabled.lastIndexOf(true);
    default:
      return null;
  }
}

// ---------- tabs ----------

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern): one tab stop, arrow keys move between tabs and select
 * them. Uncontrolled by default; pass `value` and `onChange` to control it.
 */
export function Tabs({
  tabs,
  label,
  defaultValue,
  value,
  onChange,
  className,
}: {
  tabs: TabItem[];
  /** Names the tab list for screen readers. */
  label: string;
  defaultValue?: string;
  value?: string;
  onChange?: (id: string) => void;
  className?: string;
}) {
  const base = useId();
  const firstEnabled = tabs.find((t) => !t.disabled)?.id ?? tabs[0]?.id ?? "";
  const [inner, setInner] = useState(defaultValue ?? firstEnabled);
  const selected = value ?? inner;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (id: string) => {
    if (value === undefined) setInner(id);
    onChange?.(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((t) => t.id === selected);
    const to = nextIndex(
      e.key,
      current < 0 ? 0 : current,
      tabs.map((t) => !t.disabled),
    );
    if (to === null) return;
    e.preventDefault();
    const tab = tabs[to];
    if (!tab) return;
    select(tab.id);
    refs.current[to]?.focus();
  };

  return (
    <div className={className}>
      <div className={s.tabList} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab, i) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              disabled={tab.disabled}
              className={s.tab}
              onClick={() => select(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== selected}
          className={s.tabPanel}
        >
          {tab.id === selected ? tab.content : null}
        </div>
      ))}
    </div>
  );
}

// ---------- segmented control ----------

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Small text under the label, for example a price. */
  detail?: ReactNode;
  /** Colours the selected segment: yes is lime, no is coral. */
  tone?: "yes" | "no";
  disabled?: boolean;
}

/**
 * One choice out of a few, as a row of segments. Built on native radio buttons in a fieldset, so
 * the group is one tab stop and the arrow keys move the choice in every browser and screen reader.
 * Always controlled.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  name,
  size = "md",
  block,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers. */
  label: string;
  /** The radio group's name; generated when left out. */
  name?: string;
  size?: "sm" | "md" | "lg";
  block?: boolean;
}) {
  const generated = useId();
  const group = name ?? generated;
  return (
    <fieldset className={cx(s.segmented, s[`segmented-${size}`], block && s.block)}>
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cx(s.segment, option.tone && s[`segment-${option.tone}`])}
          data-checked={option.value === value || undefined}
          data-disabled={option.disabled || undefined}
        >
          <input
            className={s.segmentInput}
            type="radio"
            name={group}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className={s.segmentLabel}>{option.label}</span>
          {option.detail ? <span className={s.segmentDetail}>{option.detail}</span> : null}
        </label>
      ))}
    </fieldset>
  );
}
