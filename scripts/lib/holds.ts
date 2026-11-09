// Changes the checks would not apply on their own (data/state/holds.json). The site keeps the old
// value; the bot keeps one «Needs a look» issue in step with this file. A hold goes away when a
// later run applies or confirms that field, or after HOLD_DAYS.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { diffDays, type ISO } from "../../src/dates.ts";
import { CountryCode, ISODate, Slug } from "../../src/schema.ts";
import { writeJson } from "./io.ts";
import { mdLink, mdTable, mdText } from "./markdown.ts";
import { fieldLabel } from "./report.ts";
import type { ReviewedChange } from "./validate.ts";

export const Hold = z
  .object({
    day: ISODate,
    country: CountryCode,
    slug: Slug,
    name: z.string(),
    year: z.number().int(),
    field: z.string(),
    old: z.union([z.string(), z.number(), z.null()]),
    new: z.union([z.string(), z.number(), z.null()]),
    flags: z.array(z.string()),
    sources: z.array(z.string()),
    quote: z.string(),
  })
  .strict();
export type Hold = z.infer<typeof Hold>;
export const HoldsFile = z.array(Hold);

export const HOLDS_PATH = join("data", "state", "holds.json");
export const HOLD_DAYS = 90;

const keyOf = (h: { country: string; slug: string; year: number; field: string }): string => `${h.country}/${h.slug}/${h.year}/${h.field}`;

export function holdFor(c: ReviewedChange, today: ISO): Hold {
  return {
    day: today,
    country: c.country,
    slug: c.slug,
    name: c.name,
    year: c.year,
    field: c.field,
    old: c.old,
    new: c.new,
    flags: c.flags,
    sources: c.sources.map((s) => s.url),
    quote: c.quote.slice(0, 500),
  };
}

/** New flags replace older holds on the same field; applied or confirmed fields and old holds drop out. */
export function mergeHolds(existing: readonly Hold[], flagged: readonly ReviewedChange[], settled: readonly ReviewedChange[], today: ISO): Hold[] {
  const done = new Set(settled.map(keyOf));
  const fresh = new Map(flagged.map((c) => [keyOf(c), holdFor(c, today)]));
  const kept = existing.filter((h) => !done.has(keyOf(h)) && !fresh.has(keyOf(h)) && diffDays(h.day, today) <= HOLD_DAYS);
  return [...kept, ...fresh.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

export function readHolds(root: string): Hold[] {
  const path = join(root, HOLDS_PATH);
  return existsSync(path) ? HoldsFile.parse(JSON.parse(readFileSync(path, "utf8"))) : [];
}

export function writeHolds(root: string, holds: readonly Hold[]): void {
  writeJson(join(root, HOLDS_PATH), HoldsFile.parse(holds));
}

/** Body of the pinned «Needs a look» issue. Web text goes through mdText, links only through mdLink. */
export function renderHolds(holds: readonly Hold[], today: ISO): string {
  const head = `Updated ${today} by the pipeline. These changes passed the source checks but were not applied on their own; the site keeps the old value. Each one is tried again on the next check of that festival, and drops out after ${HOLD_DAYS} days.`;
  if (!holds.length) return `${head}\n\nNothing is held right now.\n`;
  const rows = holds.map((h) => [
    h.day,
    h.country,
    mdText(h.name, 60),
    mdText(fieldLabel(h.field)),
    mdText(h.old),
    mdText(h.new),
    h.sources.length ? h.sources.map((u, i) => mdLink(`[${i + 1}]`, u)).join(" ") : "—",
    h.flags.map((f) => mdText(f, 160)).join("<br>"),
  ]);
  return `${head}\n\n${mdTable(["Day", "Country", "Festival", "Field", "Before", "Proposed", "Sources", "Why held"], rows)}\n`;
}
