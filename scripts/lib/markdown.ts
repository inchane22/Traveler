// Safe Markdown for PR bodies. Everything that comes from the web (quotes, titles, URLs) is escaped
// so it cannot inject links, mentions, HTML or table breaks into the review page.

/** Escapes Markdown/HTML metacharacters, folds newlines and trims to `max` characters. */
export function mdText(value: unknown, max = 280): string {
  const s = value === null || value === undefined ? "—" : String(value);
  const flat = s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  // @ and # are escaped too, so quoted text cannot ping users or link issues.
  return cut.replace(/[\\`*_{}[\]()<>#+!|~@]/g, (c) => `\\${c}`) || "—";
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
