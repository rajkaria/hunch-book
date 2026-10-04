"use client";

import type { CreateTemplate } from "@/lib/create/templates";
import { Badge } from "../ui";
import s from "./create.module.css";

/**
 * Step 1: one card per template the factory has registered. Native radio buttons inside a fieldset,
 * so the group is one tab stop and the arrow keys move the choice.
 */
export function TemplatePicker({
  templates,
  selected,
  onSelect,
}: {
  templates: readonly CreateTemplate[];
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <fieldset className={s.templates}>
      <legend className="visually-hidden">Template</legend>
      {templates.map((t) => {
        const checked = t.id === selected;
        const titleId = `template-${t.id}-title`;
        return (
          <label key={t.id} className={s.template} data-checked={checked || undefined}>
            <input
              className={s.templateInput}
              type="radio"
              name="template"
              value={t.id}
              checked={checked}
              onChange={() => onSelect(t.id)}
              aria-labelledby={titleId}
              aria-describedby={`template-${t.id}-summary`}
            />
            <span className={s.templateHead}>
              <span className={s.templateTitle} id={titleId}>
                {t.title}
              </span>
              <Badge tone={t.clock === "block" ? "violet" : "cyan"}>
                {t.clock === "block" ? "Blocks" : "Clock"}
              </Badge>
            </span>
            <span className={s.templateSummary} id={`template-${t.id}-summary`}>
              {t.summary}
            </span>
            <span className={s.example}>{t.example}</span>
            <span className={s.facts}>
              <span className={s.fact}>
                <span className={s.factKey}>Source</span>
                <span>{t.source}</span>
              </span>
              <span className={s.fact}>
                <span className={s.factKey}>Settles</span>
                <span>{t.speed}</span>
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
