// Safe Markdown for PR bodies. Everything that comes from the web (quotes, titles, URLs) is escaped
// so it cannot inject links, mentions, HTML, entities or table breaks into the review page.

/**
 * Escapes Markdown/HTML metacharacters, folds newlines and trims to `max` characters. GitHub also
 * autolinks bare `https://` and `www.` text, so the `//` after a scheme and the dot after `www`
 * become entities: the reviewer reads the address but cannot click it (SEC-04). `&` is escaped
 * first, so a quote cannot smuggle its own entities.
 */
export function mdText(value: unknown, max = 280): string {
  const s = value === null || value === undefined ? "—" : String(value);
  const flat = s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  // @ and # are escaped too, so quoted text cannot ping users or link issues.
  const escaped = cut.replace(/&/g, "&amp;").replace(/[\\`*_{}[\]()<>#+!|~@]/g, (c) => `\\${c}`);
  return escaped.replace(/:\/\//g, ":&#47;&#47;").replace(/\b(www)\./gi, "$1&#46;") || "—";
}

/** https link with an escaped label; anything else renders as plain escaped text. */
export function mdLink(label: string, url: string): string {
  let href: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return mdText(label);
    href = u.href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
  } catch {
    return mdText(label);
  }
  return `[${mdText(label, 80)}](${href})`;
}

export function mdTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}
