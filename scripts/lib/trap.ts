// R12: once a month the refresh PR carries one deliberately wrong change. Its HMAC fingerprint goes
// only to $GITHUB_OUTPUT (the workflow keeps it as a secret); check-trap.ts fails CI while it is present.
import { createHmac } from "node:crypto";
import { addDays, diffDays, formatDayMonth, type ISO } from "../../src/dates.ts";
import type { CountryFile, Lang } from "../../src/schema.ts";
import type { ScoringConfig } from "../../src/score.ts";
import { buildEntries } from "../../src/festivals.ts";
import { hostOf, registrableDomain, tierOf, isOfficial, type DomainPolicy } from "./domains.ts";
import { langFor } from "./lang.ts";
import { riskOf, type ChangeValue, type ReviewedChange } from "./validate.ts";

export interface Fingerprintable {
  country: string;
  slug: string;
  field: string;
  new: unknown;
}

export function canonicalValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** HMAC-SHA256(secret, "country|slug|field|new"), lowercase hex. */
export function fingerprint(secret: string, c: Fingerprintable): string {
  return createHmac("sha256", secret).update(`${c.country}|${c.slug}|${c.field}|${canonicalValue(c.new)}`).digest("hex");
}

export function parseFingerprints(list: string | undefined): Set<string> {
  return new Set((list ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s)));
}

/** Entries whose fingerprint is in the list. */
export function findTraps<T extends Fingerprintable>(secret: string, fingerprints: ReadonlySet<string>, items: readonly T[]): T[] {
  return items.filter((c) => fingerprints.has(fingerprint(secret, c)));
}

function phrase(lang: Lang, start: ISO, end: ISO): string {
  const year = end.slice(0, 4);
  const a = formatDayMonth(start, lang);
  const b = formatDayMonth(end, lang);
  if (lang === "en") return `from ${a} to ${b}, ${year}`;
  return lang === "pt" ? `de ${a} a ${b} de ${year}` : `del ${a} al ${b} de ${year}`;
}

export interface TrapInput {
  secret: string;
  month: string;
  today: ISO;
  countries: readonly CountryFile[];
  config: ScoringConfig;
  policies: ReadonlyMap<string, DomainPolicy>;
}

/**
 * Picks an upcoming dated edition (tier 1 first, so the reviewer checklist covers it) and moves its
 * end two days later, with a quote that the source does not contain. Deterministic per secret+month.
 */
export function makeTrap(input: TrapInput): ReviewedChange | null {
  const pool = input.countries
    .filter((c) => c.status === "publicado")
    .flatMap((c) => buildEntries(c, input.config, input.today).map((e) => ({ c, e })))
    .filter(({ e }) => e.occurrence?.origin === "edition" && e.occurrence.start && e.occurrence.end && e.occurrence.start > input.today && (e.occurrence.edition?.sources.length ?? 0) > 0);
  if (!pool.length) return null;
  const tier1 = pool.filter(({ e }) => e.score.tier === 1);
  const candidates = (tier1.length ? tier1 : pool).sort((a, b) => `${a.c.country}/${a.e.festival.slug}`.localeCompare(`${b.c.country}/${b.e.festival.slug}`));
  const pick = createHmac("sha256", input.secret).update(`trap|${input.month}`).digest().readUInt32BE(0) % candidates.length;
  const { c, e } = candidates[pick]!;
  const occ = e.occurrence!;
  const edition = occ.edition!;
  const source = edition.sources[0]!;
  const policy = input.policies.get(c.country);
  const host = hostOf(source.url) ?? source.url;
  const newEnd = addDays(occ.end!, 2);
  const lang = langFor(c.country);
  const daysToStart = diffDays(input.today, occ.start!);
  const old: ChangeValue = occ.end!;
  return {
    country: c.country,
    slug: e.festival.slug,
    name: e.festival.names.es,
    tier: e.score.tier,
    year: occ.year,
    daysToStart,
    field: "end",
    old,
    new: newEnd,
    kind: "change",
    sources: [{ url: source.url, host, domain: registrableDomain(host), tier: policy ? tierOf(source.url, policy) : (source.tier ?? "C"), official: policy ? isOfficial(source.url, policy) : false, title: source.publisher }],
    quote_url: source.url,
    quote: phrase(lang, occ.start!, newEnd),
    quote_language: lang,
    proposed_confidence: edition.confidence,
    confidence: edition.confidence,
    note: "La fuente amplía el cierre de la edición.",
    verdict: "accepted",
    flags: [],
    reasons: [],
    adjustments: [],
    risk: riskOf("end", e.score.tier, daysToStart, edition.status === "confirmada"),
  };
}
