"use client";

import { useCallback, useState } from "react";
import { appNetworkLabel } from "@/lib/config";
import { EMPTY_RESULT, type FormResult } from "@/lib/create/build";
import { useCreateConfig, useExistingMarket, usePreview } from "@/lib/create/hooks";
import type { CreatePrefill } from "@/lib/create/prefill";
import { availableTemplates, type CreateTemplate } from "@/lib/create/templates";
import { useNow } from "@/lib/hooks";
import { EmptyState, ErrorState, LoadingRows } from "../states";
import { Notice } from "../ui";
import s from "./create.module.css";
import { FirstStakePanel } from "./FirstStakePanel";
import { ParlayForm } from "./ParlayForm";
import { PerplForm } from "./PerplForm";
import { PreviewPanel } from "./PreviewPanel";
import { PriceForm } from "./PriceForm";
import { SnapshotForm } from "./SnapshotForm";
import { TemplatePicker } from "./TemplatePicker";
import { TouchForm } from "./TouchForm";

const STEP_NAMES = ["Template", "Parameters", "First stake"] as const;

function Steps({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className={s.steps} aria-label="Steps">
      {STEP_NAMES.map((name, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li
            key={name}
            className={s.step}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className={s.stepNum} aria-hidden="true">
              {i < current ? "✓" : i + 1}
            </span>
            <span className={s.stepText}>{name}</span>
            {state === "done" ? <span className="visually-hidden"> (done)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Puts `?template=<id>` in the address bar, so the choice survives a refresh and can be shared. */
function setTemplateInUrl(id: number) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("template", String(id));
  window.history.replaceState(null, "", url);
}

/**
 * On a phone the parameters sit below every template card, so after a pick the page moves to them.
 * Wide screens show both at once and stay put.
 */
function revealParameters() {
  if (typeof window === "undefined" || !window.matchMedia?.("(max-width: 959px)").matches) return;
  window.requestAnimationFrame(() => {
    document.getElementById("params-title")?.scrollIntoView({ block: "start" });
  });
}

/** The form for a template, by kind. A new template adds one case here. */
function TemplateForm({
  template,
  resolver,
  now,
  onResult,
  prefill,
}: {
  template: CreateTemplate;
  resolver: `0x${string}`;
  now: number;
  onResult: (r: FormResult) => void;
  prefill?: CreatePrefill;
}) {
  switch (template.kind) {
    case "perpl-funding":
      return <PerplForm now={now} rule="window" resolver={resolver} onResult={onResult} prefill={prefill} />;
    case "perpl-spike":
      return <PerplForm now={now} rule="spike" resolver={resolver} onResult={onResult} prefill={prefill} />;
    case "price-at-time":
      return <PriceForm now={now} rule="at" resolver={resolver} onResult={onResult} />;
    case "price-range":
      return <PriceForm now={now} rule="range" resolver={resolver} onResult={onResult} />;
    case "price-touch":
      return <TouchForm now={now} resolver={resolver} onResult={onResult} />;
    case "parlay":
      return <ParlayForm now={now} resolver={resolver} onResult={onResult} />;
    case "snapshot":
      return <SnapshotForm now={now} resolver={resolver} onResult={onResult} />;
    default:
      return null;
  }
}

/** /create: pick a template, fill its parameters, preview the exact rule, make the first stake. */
export function CreateFlow({
  initialTemplate,
  prefill,
}: {
  initialTemplate: number | null;
  /** Values handed over in the query string; used only for the template the link named. */
  prefill?: CreatePrefill;
}) {
  const config = useCreateConfig();
  const now = useNow(30_000);
  const [templateId, setTemplateId] = useState<number | null>(initialTemplate);
  const [result, setResult] = useState<FormResult>(EMPTY_RESULT);
  const onResult = useCallback((r: FormResult) => setResult(r), []);

  const registered = config.data ? Object.keys(config.data.templates).map(Number) : [];
  const templates = availableTemplates(registered);
  const selected = templates.find((t) => t.id === templateId) ?? null;
  const registration = selected && config.data ? config.data.templates[selected.id] : undefined;
  const activePrefill = selected && selected.id === initialTemplate ? prefill : undefined;

  const preview = usePreview(registration?.resolver, result.params);
  const existing = useExistingMarket(config.data?.factory, selected?.id ?? null, result.params);

  if (config.isPending || now === null) return <LoadingRows rows={2} label="Reading the factory" />;
  if (config.isError || !config.data) {
    return (
      <ErrorState
        title="Could not read the factory"
        detail={`The ${appNetworkLabel} RPC did not answer for the factory's templates and limits. Nothing was sent.`}
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (templates.length === 0) {
    return (
      <EmptyState label="No templates" title="No templates are registered yet">
        <p>The factory on {appNetworkLabel} has no template this app can build a market from.</p>
      </EmptyState>
    );
  }

  const cfg = config.data;
  const paramsSettled = result.params !== null && !preview.settling && preview.data !== undefined;
  const paramsOk = paramsSettled && preview.data?.error === null && preview.data?.window !== null;
  const existingMarket = result.params !== null && !preview.settling ? (existing.data ?? null) : null;
  const current: 0 | 1 | 2 = !selected ? 0 : paramsOk && existingMarket === null ? 2 : 1;

  return (
    <>
      <Steps current={current} />
      {cfg.paused ? (
        <div style={{ marginBottom: 24 }}>
          <Notice tone="warn" title="Creation is paused" role="status">
            <p>
              The guardian has paused new markets on {appNetworkLabel}. You can still fill in a market and
              preview its rule. Existing markets, settlement and redemption are not affected.
            </p>
          </Notice>
        </div>
      ) : null}

      <section aria-labelledby="pick-title">
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle} id="pick-title">
            Step 1: pick a template
          </h2>
          <span className="subtle" style={{ fontSize: 14 }}>
            Every template settles by reading the chain. Nobody, including us, can set an outcome.
          </span>
        </div>
        <TemplatePicker
          templates={templates}
          selected={selected?.id ?? null}
          onSelect={(id) => {
            setResult(EMPTY_RESULT);
            setTemplateId(id);
            setTemplateInUrl(id);
            revealParameters();
          }}
        />
      </section>

      {selected && registration ? (
        <div className={s.grid}>
          <div className={s.formArea}>
            <TemplateForm
              key={selected.id}
              template={selected}
              resolver={registration.resolver}
              now={now}
              onResult={onResult}
              prefill={activePrefill}
            />
          </div>
          <div className={s.previewArea}>
            <PreviewPanel
              template={selected}
              result={result}
              preview={result.params !== null ? preview.data : undefined}
              previewPending={preview.settling || preview.isPending}
              previewFailed={preview.isError}
              existing={existingMarket}
              rule={registration.rule}
              caps={cfg.caps}
            />
          </div>
          <div className={s.stakeArea}>
            <FirstStakePanel
              config={cfg}
              templateId={selected.id}
              params={paramsOk ? result.params : null}
              marketKey={paramsOk ? existing.key : null}
              paramsOk={paramsOk}
              existing={existingMarket}
              initialSide={activePrefill?.side}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
