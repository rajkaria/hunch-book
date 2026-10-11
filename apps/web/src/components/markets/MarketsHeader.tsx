import type { ReactNode } from "react";
import s from "./explorer.module.css";

/** The markets page head: a big title on the left, the lede to its right on wide screens. */
export function MarketsHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className={s.head}>
      <div className={s.headText}>
        {eyebrow ? <p className={s.eyebrow}>{eyebrow}</p> : null}
        <h1 className={s.headTitle}>{title}</h1>
      </div>
      {children ? <div className={s.headLede}>{children}</div> : null}
    </header>
  );
}
