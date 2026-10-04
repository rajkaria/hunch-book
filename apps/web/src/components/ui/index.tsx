import { addressUrl, Outcome, Phase, txUrl } from "@hunch-book/shared";
import Link from "next/link";
import type {
  AriaAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import type { Address, Hex } from "viem";
import { appDeployment } from "@/lib/config";
import { chanceComplementBps, formatChance, shortAddress, shortHash } from "@/lib/format";
import s from "./ui.module.css";

// The Hunch Book design system: small, plain components over the tokens in app/globals.css.
// Everything here renders on the server; the stateful pieces (Tabs, SegmentedControl) live in
// ./interactive and are re-exported at the bottom.

export const cx = (...names: (string | false | null | undefined)[]): string =>
  names.filter(Boolean).join(" ");

// ---------- buttons ----------

export type Variant = "default" | "primary" | "secondary" | "yes" | "no" | "ghost" | "danger";
export type Size = "sm" | "md" | "lg";

const variantClass: Record<Variant, string | undefined> = {
  default: s.secondary,
  secondary: s.secondary,
  primary: s.primary,
  yes: s.yes,
  no: s.no,
  ghost: s.ghost,
  danger: s.danger,
};

const sizeClass: Record<Size, string | undefined> = { sm: s.small, md: undefined, lg: s.large };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: lime on ink. default/secondary: glass. ghost: text only. yes/no: the two sides. danger: coral. */
  variant?: Variant;
  size?: Size;
  block?: boolean;
  /** Shows a spinner, sets aria-busy and blocks clicks. The label stays, so the width does not jump. */
  loading?: boolean;
}

export function Button({
  variant = "default",
  size = "md",
  block,
  loading,
  className,
  type,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx(s.button, variantClass[variant], sizeClass[size], block && s.block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className={s.spinner} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "default",
  size = "md",
  external,
  arrow,
  block,
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  /** Opens another site in a new tab. */
  external?: boolean;
  /** Adds a trailing arrow (hidden from screen readers). */
  arrow?: boolean;
  block?: boolean;
  className?: string;
}) {
  const classes = cx(s.button, variantClass[variant], sizeClass[size], block && s.block, className);
  const body = (
    <>
      {children}
      {arrow ? (
        <span className={s.arrow} aria-hidden="true">
          {external ? "↗" : "→"}
        </span>
      ) : null}
    </>
  );
  return external ? (
    <a href={href} className={classes} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <Link href={href} className={classes}>
      {body}
    </Link>
  );
}

// ---------- badge and pills ----------

export type Tone = "accent" | "yes" | "warn" | "no" | "danger" | "violet" | "cyan" | "neutral" | "muted";

export function Badge({
  tone = "neutral",
  dot,
  live,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  /** A pulsing dot, for things happening now. */
  live?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx(s.badge, s[`badge-${tone}`], className)}>
      {live ? <LiveDot /> : dot ? <span className={s.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** A small dot that pulses while motion is allowed. Decorative. */
export function LiveDot({ tone = "accent" }: { tone?: "accent" | "warn" | "no" | "muted" }) {
  return (
    <span className={cx(s.liveDot, s[`live-${tone}`])} aria-hidden="true">
      <span className={s.livePing} />
    </span>
  );
}

export interface PhaseStyle {
  label: string;
  tone: Tone;
  live: boolean;
}

/** The phase colours: pool, live book, closed, settled YES or NO, voided. */
export function phaseStyle(phase: Phase, outcome: Outcome = Outcome.Unresolved): PhaseStyle {
  switch (phase) {
    case Phase.Pool:
      return { label: "Pool", tone: "cyan", live: true };
    case Phase.PoolLocked:
      return { label: "Pool locked", tone: "warn", live: false };
    case Phase.Graduated:
      return { label: "Live book", tone: "accent", live: true };
    case Phase.Closed:
      return { label: "Closed", tone: "warn", live: false };
    case Phase.Settled:
      return outcome === Outcome.No
        ? { label: "Settled NO", tone: "no", live: false }
        : { label: "Settled YES", tone: "yes", live: false };
    case Phase.Voided:
      return { label: "Voided", tone: "muted", live: false };
    default:
      return { label: "Unknown", tone: "muted", live: false };
  }
}

export function PhasePill({ phase, outcome }: { phase: Phase; outcome?: Outcome }) {
  const style = phaseStyle(phase, outcome);
  return (
    <Badge tone={style.tone} live={style.live} dot={!style.live}>
      {style.label}
    </Badge>
  );
}

// ---------- panels and cards ----------

export type CardVariant = "hairline" | "glass" | "solid" | "accent";

export function Card({
  children,
  variant = "hairline",
  padding = "md",
  as: Tag = "div",
  interactive,
  className,
  style,
  ...aria
}: {
  children: ReactNode;
  variant?: CardVariant;
  padding?: "none" | "sm" | "md" | "lg";
  as?: "div" | "section" | "article" | "aside" | "li";
  /** Lifts on hover; use when the card is a link target. */
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
} & AriaAttributes & { id?: string; role?: string }) {
  return (
    <Tag
      className={cx(
        s.card,
        s[`card-${variant}`],
        s[`pad-${padding}`],
        interactive && s.cardInteractive,
        className,
      )}
      style={style}
      {...aria}
    >
      {children}
    </Tag>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
  as: Tag = "section",
  labelledBy,
  variant = "hairline",
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "aside";
  labelledBy?: string;
  variant?: "hairline" | "glass";
}) {
  return (
    <Tag className={cx(s.panel, variant === "glass" && s.panelGlass, className)} aria-labelledby={labelledBy}>
      {title || aside ? (
        <div className={s.panelHeader}>
          {title ? (
            <h2 className={s.panelTitle} id={labelledBy}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {aside}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}

// ---------- stat ----------

export interface StatSource {
  href: string;
  label: ReactNode;
  external?: boolean;
}

/** Label, a mono value, and optionally a hint and a link to where the number comes from. */
export function Stat({
  label,
  value,
  hint,
  source,
  size = "md",
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  source?: StatSource;
  size?: "sm" | "md" | "lg";
  tone?: "accent" | "no" | "muted";
}) {
  return (
    <div className={cx(s.stat, s[`stat-${size}`])}>
      <span className={s.statLabel}>{label}</span>
      <span className={cx(s.statValue, tone && s[`statValue-${tone}`])}>{value}</span>
      {hint ? <span className={s.statHint}>{hint}</span> : null}
      {source ? (
        source.external ? (
          <a className={s.statSource} href={source.href} target="_blank" rel="noreferrer">
            {source.label}
            <span aria-hidden="true"> ↗</span>
          </a>
        ) : (
          <Link className={s.statSource} href={source.href}>
            {source.label}
            <span aria-hidden="true"> →</span>
          </Link>
        )
      ) : null}
    </div>
  );
}

// ---------- bars ----------

const chancePct = (bps: bigint | null): number | null =>
  bps === null ? null : Math.min(100, Math.max(0, Number(bps) / 100));

/**
 * The YES/NO split bar: YES share on the left in lime, NO on the right in coral. Grey when there is
 * no chance to show. With `showLabels`, the two shares are written above it.
 */
export function ChanceBar({
  bps,
  label,
  showLabels,
  size = "md",
}: {
  bps: bigint | null;
  label?: string;
  showLabels?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const yes = chancePct(bps);
  const bar = (
    <div
      className={cx(s.bar, s[`bar-${size}`])}
      role="img"
      aria-label={label ?? (bps === null ? "No chance to show yet" : `YES ${formatChance(bps)}`)}
    >
      {yes === null ? null : (
        <>
          {yes > 0 ? <span className={s.barYes} style={{ flexGrow: yes }} /> : null}
          {yes < 100 ? <span className={s.barNo} style={{ flexGrow: 100 - yes }} /> : null}
        </>
      )}
    </div>
  );
  if (!showLabels) return bar;
  return (
    <div className={s.barWrap}>
      <div className={s.barLabels} aria-hidden="true">
        <span className={s.barLabelYes}>
          YES <span className="mono">{bps === null ? "n/a" : formatChance(bps)}</span>
        </span>
        <span className={s.barLabelNo}>
          NO <span className="mono">{bps === null ? "n/a" : formatChance(chanceComplementBps(bps))}</span>
        </span>
      </div>
      {bar}
    </div>
  );
}

/** Progress toward a target, for example a graduation rule. Lime once met. */
export function Progress({ ratio, met, label }: { ratio: number; met: boolean; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <div
      className={s.progress}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className={cx(s.progressFill, met && s.progressMet)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Same as Progress; the name the design system documents. */
export const ProgressBar = Progress;

// ---------- skeleton ----------

export function Skeleton({
  width = "100%",
  height = 16,
  radius,
  style,
}: {
  width?: string | number;
  height?: number;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      className={s.skeleton}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

// ---------- form fields ----------

/** The ids a control needs to point at its field's hint and error. */
export function fieldA11y(
  id: string,
  { hint, error }: { hint?: boolean; error?: boolean } = {},
): { id: string; "aria-describedby"?: string; "aria-invalid"?: true } {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return {
    id,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
  };
}

/**
 * A labelled field: label, the control, a hint and an error. Pass the control the ids from
 * `fieldA11y(id, { hint, error })` so screen readers read the hint and the error with it.
 */
export function Field({
  id,
  label,
  hint,
  error,
  aside,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Right side of the label row, for example a balance. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cx(s.field, error ? s.fieldInvalid : undefined)}>
      <div className={s.fieldHead}>
        <label className={s.fieldLabel} htmlFor={id}>
          {label}
        </label>
        {aside ? <span className={s.fieldAside}>{aside}</span> : null}
      </div>
      {children}
      {hint ? (
        <p className={s.fieldHint} id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className={s.fieldError} id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** A unit shown at the right edge, for example USDC. */
  unit?: ReactNode;
  /** Monospace tabular figures, for amounts. */
  mono?: boolean;
}

export function Input({ unit, mono, className, ...rest }: InputProps) {
  return (
    <div className={cx(s.inputWrap, rest["aria-invalid"] ? s.inputInvalid : undefined, className)}>
      <input className={cx(s.input, mono && s.inputMono)} {...rest} />
      {unit ? <span className={s.inputUnit}>{unit}</span> : null}
    </div>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(s.textarea, className)} {...rest} />;
}

/**
 * Help that opens in place, instead of a tooltip: works by touch, keyboard and screen reader, and
 * needs no script.
 */
export function InlineHelp({
  summary = "What does this mean?",
  children,
}: {
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className={s.help}>
      <summary className={s.helpSummary}>
        <span className={s.helpIcon} aria-hidden="true">
          ?
        </span>
        {summary}
      </summary>
      <div className={s.helpBody}>{children}</div>
    </details>
  );
}

// ---------- icons ----------

/** A 24 by 24 line icon drawn in the current colour. Decorative: hidden from screen readers. */
export function LineIcon({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

// ---------- explorer links ----------

export function AddressLink({ address, full, label }: { address: Address; full?: boolean; label?: string }) {
  return (
    <a
      className={s.addr}
      href={addressUrl(appDeployment, address)}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {label ?? (full ? address : shortAddress(address))}
    </a>
  );
}

export function TxLink({ hash }: { hash: Hex }) {
  return (
    <a className={s.addr} href={txUrl(appDeployment, hash)} target="_blank" rel="noreferrer" title={hash}>
      {shortHash(hash)}
    </a>
  );
}

// ---------- key/value list ----------

export function KeyValues({ items }: { items: { label: ReactNode; value: ReactNode; key?: string }[] }) {
  return (
    <dl className={s.kv}>
      {items.map((item, i) => (
        <div
          key={item.key ?? (typeof item.label === "string" ? item.label : i)}
          style={{ display: "contents" }}
        >
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- notice ----------

export function Notice({
  tone = "neutral",
  title,
  children,
  role,
}: {
  tone?: "neutral" | "warn" | "danger" | "accent";
  title?: ReactNode;
  children?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={cx(s.notice, tone !== "neutral" && s[`notice-${tone}`])} role={role}>
      {title ? <p className={s.noticeTitle}>{title}</p> : null}
      {children}
    </div>
  );
}

export { SegmentedControl, type SegmentOption, type TabItem, Tabs } from "./interactive";
