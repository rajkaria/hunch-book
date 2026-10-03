import { addressUrl, txUrl } from "@hunch-book/shared";
import Link from "next/link";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { Address, Hex } from "viem";
import { appDeployment } from "@/lib/config";
import { formatChance, shortAddress, shortHash } from "@/lib/format";
import s from "./ui.module.css";

const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");

// ---------- buttons ----------

type Variant = "default" | "primary" | "yes" | "no" | "ghost";

const variantClass: Record<Variant, string | undefined> = {
  default: undefined,
  primary: s.primary,
  yes: s.yes,
  no: s.no,
  ghost: s.ghost,
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  block?: boolean;
}

export function Button({ variant = "default", size = "md", block, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx(s.button, variantClass[variant], size === "sm" && s.small, block && s.block, className)}
      {...rest}
    />
  );
}

export function ButtonLink({
  href,
  children,
  variant = "default",
  size = "md",
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
  size?: "md" | "sm";
}) {
  return (
    <Link href={href} className={cx(s.button, variantClass[variant], size === "sm" && s.small)}>
      {children}
    </Link>
  );
}

// ---------- badge ----------

export type Tone = "accent" | "warn" | "no" | "neutral" | "muted";

export function Badge({
  tone = "neutral",
  dot,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cx(s.badge, s[`badge-${tone}`])}>
      {dot ? <span className={s.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

// ---------- panel ----------

export function Panel({
  title,
  aside,
  children,
  className,
  as: Tag = "section",
  labelledBy,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "aside";
  labelledBy?: string;
}) {
  return (
    <Tag className={cx(s.panel, className)} aria-labelledby={labelledBy}>
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

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className={s.stat}>
      <span className={s.statLabel}>{label}</span>
      <span className={s.statValue}>{value}</span>
      {hint ? <span className={s.statHint}>{hint}</span> : null}
    </div>
  );
}

// ---------- bars ----------

/** YES share on the left, NO on the right. Grey when there is no chance to show. */
export function ChanceBar({ bps, label }: { bps: bigint | null; label?: string }) {
  const yes = bps === null ? null : Math.min(100, Math.max(0, Number(bps) / 100));
  return (
    <div
      className={s.bar}
      role="img"
      aria-label={label ?? (bps === null ? "No chance to show yet" : `YES ${formatChance(bps)}`)}
    >
      {yes === null ? null : (
        <>
          <span className={s.barYes} style={{ width: `${yes}%` }} />
          <span className={s.barNo} style={{ width: `${100 - yes}%` }} />
        </>
      )}
    </div>
  );
}

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

// ---------- skeleton ----------

export function Skeleton({
  width = "100%",
  height = 16,
  style,
}: {
  width?: string | number;
  height?: number;
  style?: CSSProperties;
}) {
  return <span className={s.skeleton} style={{ width, height, ...style }} aria-hidden="true" />;
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
