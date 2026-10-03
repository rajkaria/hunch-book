import type { ReactNode } from "react";
import { appNetwork, appNetworkLabel } from "@/lib/config";
import { Button, Skeleton } from "../ui";
import s from "./states.module.css";

/** Shown wherever chain data is needed while deployments/<network>.json has no factory yet. */
export function NotDeployed({ willShow }: { willShow?: string[] }) {
  return (
    <section className={s.state} aria-labelledby="not-deployed-title">
      <p className={s.label}>Status: building</p>
      <h2 className={s.title} id="not-deployed-title">
        Contracts not deployed on {appNetworkLabel} yet
      </h2>
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
    </section>
  );
}

export function EmptyState({
  label,
  title,
  children,
  actions,
}: {
  label?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={s.state}>
      {label ? <p className={s.label}>{label}</p> : null}
      <h2 className={s.title}>{title}</h2>
      {children ? <div className={s.body}>{children}</div> : null}
      {actions ? <div className={s.actions}>{actions}</div> : null}
    </section>
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
    <section className={s.state} role="alert">
      <p className={s.label}>Error</p>
      <h2 className={s.title}>{title}</h2>
      <p className={s.body}>
        {detail ??
          `The ${appNetworkLabel} RPC did not answer. Your funds are not affected. Try again in a moment.`}
      </p>
      {onRetry ? (
        <div className={s.actions}>
          <Button onClick={onRetry}>Try again</Button>
        </div>
      ) : null}
    </section>
  );
}

export function LoadingRows({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className={s.loading} role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
        <div className={s.loadingRow} key={key}>
          <Skeleton width="70%" height={18} />
          <Skeleton width="40%" height={14} />
        </div>
      ))}
    </div>
  );
}
