// The incident log, written in docs/INCIDENTS.md and rendered on /status. A tiny parser for the
// subset of Markdown the log uses: "## " entry headings, paragraphs, "- " bullets and [text](url)
// links. Anything else shows as plain text, never as HTML.

export type Inline = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; parts: Inline[] }
  | { kind: "list"; items: Inline[][] };

const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Splits text into plain runs and links. Only http(s) links become links; the rest stays text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push({ kind: "link", text: m[1] as string, href: m[2] as string });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.map((p) => (p.kind === "text" ? { ...p, text: p.text.replace(/\*\*|`/g, "") } : p));
}

/** The log as blocks. The document's own "# " title is dropped; the page has its own heading. */
export function parseIncidents(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", parts: parseInline(paragraph.join(" ")) });
    paragraph = [];
    if (list) blocks.push({ kind: "list", items: list.map(parseInline) });
    list = null;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      flush();
    } else if (/^#\s/.test(line)) {
      flush();
    } else if (/^#{2,6}\s/.test(line)) {
      flush();
      blocks.push({ kind: "heading", text: line.replace(/^#{2,6}\s+/, "") });
    } else if (/^[-*]\s/.test(line)) {
      if (paragraph.length > 0) {
        blocks.push({ kind: "paragraph", parts: parseInline(paragraph.join(" ")) });
        paragraph = [];
      }
      list ??= [];
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list[list.length - 1] += ` ${line}`;
    } else {
      if (list) {
        blocks.push({ kind: "list", items: list.map(parseInline) });
        list = null;
      }
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** True when the log has no entries yet (no "## " headings). */
export function hasIncidents(blocks: readonly Block[]): boolean {
  return blocks.some((b) => b.kind === "heading");
}
