import type { ReactNode } from "react";
import { appNetwork, appNetworkLabel } from "@/lib/config";
import { Button, LineIcon, Skeleton } from "../ui";
import s from "./states.module.css";

// Loading, empty, error and not-deployed states. Plain words, a way forward, never a stack trace.

type Glyph = "build" | "empty" | "error" | "search";

/** Small line icons for the state tile. Decorative: the heading carries the meaning. */
function StateIcon({ glyph }: { glyph: Glyph }) {
  switch (glyph) {
    case "build":
      return (
        <LineIcon>
          <path d="M4 20h16" />
          <path d="M6 20V9l6-5 6 5v11" />
          <path d="M10 20v-5h4v5" />
        </LineIcon>
      );
    case "error":
      return (
        <LineIcon>
          <path d="M12 3 2.5 20h19L12 3Z" />
          <path d="M12 10v4" />
          <path d="M12 17.2v.1" />
        </LineIcon>
      );
    case "search":
      return (
        <LineIcon>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-4.2-4.2" />
        </LineIcon>
      );
    default:
      return (
        <LineIcon>
          <rect x="4" y="5" width="16" height="14" rx="3" />
          <path d="M4 10h16" />
          <path d="M9 14.5h6" />
        </LineIcon>
      );
  }
}

function StateFrame({
  glyph,
  tone = "neutral",
  label,
  title,
  titleAs: Title = "h2",
  titleId,
  role,
  labelledBy,
  children,
  actions,
}: {
  glyph: Glyph;
  tone?: "neutral" | "accent" | "danger";
  label?: string;
  title: ReactNode;
  titleAs?: "h1" | "h2";
  titleId?: string;
  role?: "alert";
  labelledBy?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={`${s.state} ${s[`state-${tone}`] ?? ""}`} role={role} aria-labelledby={labelledBy}>
      <span className={s.icon}>
        <StateIcon glyph={glyph} />
      </span>
      <div className={s.content}>
        {label ? <p className={s.label}>{label}</p> : null}
        <Title className={s.title} id={titleId}>
          {title}
        </Title>
        {children}
        {actions ? <div className={s.actions}>{actions}</div> : null}
      </div>
    </section>
  );
}

/** Shown wherever chain data is needed while deployments/<network>.json has no factory yet. */
export function NotDeployed({ willShow }: { willShow?: string[] }) {
  return (
    <StateFrame
      glyph="build"
      tone="accent"
      label="Status: building"
      title={`Contracts not deployed on ${appNetworkLabel} yet`}
      titleId="not-deployed-title"
      labelledBy="not-deployed-title"
    >
      <p className={s.body}>
        Hunch Book's contracts are being built. <span className={s.code}>deployments/{appNetwork}.json</span>{" "}
        has no factory address yet. Once the deploy writes one, this page reads markets straight from the
        chain.
      </p>
      {willShow && willShow.length > 0 ? (
        <>
          <p className={s.body}>What will appear here:</p>
          <ul className={s.list}>
            {willShow.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}
    </StateFrame>
  );
}

export function EmptyState({
  label,
  title,
  children,
  actions,
  glyph = "empty",
  titleAs = "h2",
}: {
  label?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  glyph?: Glyph;
  /** h1 when the empty state is the whole page, as on the 404 page. */
  titleAs?: "h1" | "h2";
}) {
  return (
    <StateFrame glyph={glyph} label={label} title={title} titleAs={titleAs} actions={actions}>
      {children ? <div className={s.body}>{children}</div> : null}
    </StateFrame>
  );
}

/** A read failed: say so plainly and offer a retry. Never shows raw stack traces. */
export function ErrorState({
  title = "Could not load this from the chain",
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <StateFrame
      glyph="error"
      tone="danger"
      label="Error"
      title={title}
      role="alert"
      actions={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
    >
      <p className={s.body}>
        {detail ??
          `The ${appNetworkLabel} RPC did not answer. Your funds are not affected. Try again in a moment.`}
      </p>
    </StateFrame>
  );
}

export function LoadingRows({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className={s.loading} role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
        <div className={s.loadingRow} key={key}>
          <div className={s.loadingMeta}>
            <Skeleton width={72} height={22} radius={999} />
            <Skeleton width={56} height={14} />
          </div>
          <Skeleton width="72%" height={20} />
          <div className={s.loadingFoot}>
            <Skeleton width={64} height={24} />
            <Skeleton width="100%" height={8} radius={999} />
          </div>
        </div>
      ))}
    </div>
  );
}
