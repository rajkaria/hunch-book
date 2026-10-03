import type { ReactNode } from "react";
import s from "./page.module.css";

export function PageHeader({
  eyebrow,
  title,
  children,
  aside,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className={s.header}>
      <div className={s.headerText}>
        {eyebrow ? <p className={s.eyebrow}>{eyebrow}</p> : null}
        <h1 className={s.title}>{title}</h1>
        {children ? <div className={s.lede}>{children}</div> : null}
      </div>
      {aside ? <div className={s.aside}>{aside}</div> : null}
    </div>
  );
}
