"use client";

import type { GraduationRule, MarketCaps, Window } from "@hunch-book/shared";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { appNetwork } from "@/lib/config";
import type { FormResult } from "@/lib/create/build";
import { capLines, FEE_LINES, ruleLines, voidLines, windowPoints } from "@/lib/create/preview";
import type { Preview } from "@/lib/create/reads";
import { type CreateTemplate, networkCaveat } from "@/lib/create/templates";
import { ButtonLink, KeyValues, Notice, Panel, Skeleton } from "../ui";
import s from "./create.module.css";
import { When } from "./When";

/**
 * The live preview: the resolver's own rule sentence and window (from `describe` and `validate`
 * through eth_call), how the market graduates, its limits, fees and void terms.
 */
export function PreviewPanel({
  template,
  result,
  preview,
  previewPending,
  previewFailed,
  existing,
  rule,
  caps,
}: {
  template: CreateTemplate;
  result: FormResult;
  preview: Preview | undefined;
  previewPending: boolean;
  previewFailed: boolean;
  existing: Address | null;
  rule: GraduationRule;
  caps: MarketCaps;
}) {
  const window: Window | null = preview?.window ?? null;
  const caveat = networkCaveat(template.kind, appNetwork);
  const hasParams = result.params !== null;

  let ruleBody: ReactNode;
  if (!hasParams) {
    ruleBody = <p className={s.rulePending}>Fill in the parameters to see the exact rule.</p>;
  } else if (previewPending || !preview) {
    ruleBody = (
      <div role="status">
        <span className="visually-hidden">Asking the resolver for the rule</span>
        <Skeleton width="100%" height={22} />
        <Skeleton width="70%" height={22} style={{ marginTop: 8 }} />
      </div>
    );
  } else if (previewFailed) {
    ruleBody = (
      <Notice tone="danger" role="alert">
        <p>Could not ask the resolver. The RPC did not answer; try again in a moment.</p>
      </Notice>
    );
  } else {
    ruleBody = (
      <>
        {preview.sentence ? (
          <p className={s.rule}>{preview.sentence}</p>
        ) : (
          <p className={s.rulePending}>The resolver did not return its rule sentence.</p>
        )}
        {preview.error ? (
          <Notice tone="danger" title="The resolver would refuse this market" role="alert">
            <p>{preview.error}</p>
          </Notice>
        ) : (
          <p className={s.small}>
            Read from the resolver's describe() and checked with its validate(), the same calls the factory
            makes when you create the market.
          </p>
        )}
      </>
    );
  }

  return (
    <Panel title="Preview" labelledBy="preview-title" variant="glass">
      <div className={s.preview} aria-live="polite">
        <div className={s.ruleBox}>
          <span className={s.blockTitle}>The rule</span>
          {ruleBody}
        </div>

        {existing ? (
          <Notice tone="accent" title="This exact market already exists">
            <p>
              Every (template, parameters) pair has one market, and this one is already open. Stake in it
              instead.
            </p>
            <div style={{ marginTop: 12 }}>
              <ButtonLink href={`/m/${existing}`} variant="primary" size="sm" arrow>
                Open the market
              </ButtonLink>
            </div>
          </Notice>
        ) : null}

        {window ? (
          <div className={s.block}>
            <span className={s.blockTitle}>Window</span>
            <ol className={s.points}>
              {windowPoints(window, result.clock, result.challengeEnd).map((p) => (
                <li className={s.point} key={p.key}>
                  <span className={s.pointTitle}>{p.title}</span>
                  <When unix={p.unix} block={p.block} estimated={p.estimated} plusMinus={p.plusMinus} />
                  <span className={s.pointNote}>{p.note}</span>
                </li>
              ))}
            </ol>
            {window.blockClock ? (
              <p className={s.small}>
                This market runs on block numbers, so its rule is exact. Clock times are estimates from the
                chain's recent block pace.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className={s.block}>
          <span className={s.blockTitle}>Graduation</span>
          <ul className={s.bullets}>
            {ruleLines(rule).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className={s.small}>
            If the pool meets every line before the lock, anyone can graduate it into fully backed YES and NO
            tokens on its own Kuru order book. If not, it settles as a pool.
          </p>
        </div>

        <div className={s.block}>
          <span className={s.blockTitle}>Limits</span>
          <KeyValues items={capLines(caps).map((c) => ({ key: c.label, label: c.label, value: c.value }))} />
        </div>

        <div className={s.block}>
          <span className={s.blockTitle}>Fees</span>
          <ul className={s.bullets}>
            {FEE_LINES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>

        {window ? (
          <div className={s.block}>
            <span className={s.blockTitle}>If there is no answer</span>
            <ul className={s.bullets}>
              {voidLines(template.kind, window, result.priceSource ?? undefined).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {caveat ? <Notice tone="warn">{caveat}</Notice> : null}
      </div>
    </Panel>
  );
}
