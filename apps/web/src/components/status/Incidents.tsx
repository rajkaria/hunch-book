import type { Block, Inline } from "@/lib/status/incidents";
import s from "./status.module.css";

function Parts({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "link" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs never reorder
          <a key={i} href={p.href} target="_blank" rel="noreferrer">
            {p.text}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs never reorder
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** docs/INCIDENTS.md, read when the site is built. */
export function Incidents({ blocks }: { blocks: Block[] }) {
  return (
    <div className={s.incidents}>
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the log is static for a build
            <h3 key={i} className={s.incidentHeading}>
              {b.text}
            </h3>
          );
        }
        if (b.kind === "list") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the log is static for a build
            <ul key={i} className={s.details} style={{ fontSize: 14 }}>
              {b.items.map((item, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the log is static for a build
                <li key={j}>
                  <Parts parts={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the log is static for a build
          <p key={i}>
            <Parts parts={b.parts} />
          </p>
        );
      })}
    </div>
  );
}
