"use client";

import Link from "next/link";
import { useEffect } from "react";
import s from "./states/states.module.css";
import { Button } from "./ui";

/** Body of every route's error.tsx: plain words, a retry, a way out. No stack traces. */
export function RouteError({
  error,
  retry,
  what = "this page",
}: {
  error: Error & { digest?: string };
  retry: () => void;
  what?: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="page">
      <section className={s.state} role="alert">
        <p className={s.label}>Error</p>
        <h1 className={s.title}>Something went wrong loading {what}</h1>
        <p className={s.body}>
          This is a problem on our side or with the network, not with your funds. Nothing was sent from your
          wallet.
          {error.digest ? (
            <>
              {" "}
              Reference: <span className="mono">{error.digest}</span>.
            </>
          ) : null}
        </p>
        <div className={s.actions}>
          <Button variant="primary" onClick={() => retry()}>
            Try again
          </Button>
          <Link href="/markets">Go to markets</Link>
        </div>
      </section>
    </div>
  );
}
