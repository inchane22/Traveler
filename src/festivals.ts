// Ranking, visibility, upcoming and filters over a country's festivals. Pure: shared by app and scripts.
import { addMonths, effectiveEnd, effectiveStart, occurrenceFor, overlaps, resolveRule, type ISO, type Occurrence, type RuleContext } from "./dates.ts";
import type { CountryFile, Festival, FestivalType } from "./schema.ts";
import { scoreFestival, type ScoreResult, type ScoringConfig } from "./score.ts";

export interface FestivalEntry {
  country: string;
  region: CountryFile["region"];
  festival: Festival;
  score: ScoreResult;
  /** Next edition that has not ended yet (may be ongoing). */
  occurrence: Occurrence | null;
  rank: number;
  inTopN: boolean;
}

export type Scope = { kind: "world" } | { kind: "region"; region: CountryFile["region"] } | { kind: "country"; code: string };

export interface Filters {
  months?: readonly string[];
  types?: readonly FestivalType[];
  from?: ISO;
  to?: ISO;
}

export interface FilterHit {
  entry: FestivalEntry;
  occurrence: Occurrence;
  /** Only a probable window overlaps the request, no announced dates yet. */
  possible: boolean;
}

export function ctxFor(country: CountryFile): RuleContext {
  const bySlug = new Map(country.festivals.map((f) => [f.slug, f]));
  const ctx: RuleContext = {
    resolveRef: (slug, year) => {
      const ref = bySlug.get(slug);
      if (!ref) return null;
      const occ = occurrenceFor(ref, year, { resolveRef: () => null });
      if (occ?.start && occ.end) return { kind: "computed", start: occ.start, end: occ.end, estimated: occ.estimated };
      return resolveRule(ref.rule, year, { resolveRef: () => null });
    },
  };
  return ctx;
}

const YEARS_BACK = 1;
const YEARS_AHEAD = 3;

export function nextOccurrence(festival: Festival, today: ISO, ctx: RuleContext): Occurrence | null {
  const year = Number(today.slice(0, 4));
  for (let y = year - YEARS_BACK; y <= year + YEARS_AHEAD; y++) {
    const occ = occurrenceFor(festival, y, ctx);
    if (occ && effectiveEnd(occ) >= today) return occ;
  }
  return null;
}

export function occurrencesBetween(festival: Festival, from: ISO, to: ISO, ctx: RuleContext): Occurrence[] {
  const out: Occurrence[] = [];
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)); y++) {
    const occ = occurrenceFor(festival, y, ctx);
    if (occ && overlaps({ start: effectiveStart(occ), end: effectiveEnd(occ) }, { start: from, end: to })) out.push(occ);
  }
  return out;
}

export function buildEntries(country: CountryFile, config: ScoringConfig, today: ISO): FestivalEntry[] {
  const ctx = ctxFor(country);
  const scored = country.festivals.map((festival) => ({ festival, score: scoreFestival(festival.score, config) }));
  const ranked = [...scored].sort(
    (a, b) => b.score.low - a.score.low || b.score.high - a.score.high || a.festival.slug.localeCompare(b.festival.slug),
  );
  return ranked.map(({ festival, score }, i) => ({
    country: country.country,
    region: country.region,
    festival,
    score,
    occurrence: nextOccurrence(festival, today, ctx),
    rank: i + 1,
    inTopN: i < config.country_top_n,
  }));
}

/**
 * World/region: tier 1 only; the switch adds tier 2 and provisional ranges.
 * Country: its top N always, plus tier 1 and provisional ones; the switch adds tier 2.
 * [assumption: provisional festivals show in the country view so unmeasured big ones never vanish]
 */
export function isVisible(entry: FestivalEntry, scope: Scope, includeTier2: boolean): boolean {
  const { tier } = entry.score;
  if (scope.kind === "country") {
    if (entry.country !== scope.code) return false;
    return entry.inTopN || tier === 1 || tier === "provisional" || (includeTier2 && tier === 2);
  }
  if (scope.kind === "region" && entry.region !== scope.region) return false;
  return tier === 1 || (includeTier2 && (tier === 2 || tier === "provisional"));
}

export function sortByDate(a: FestivalEntry, b: FestivalEntry): number {
  const sa = a.occurrence ? effectiveStart(a.occurrence) : "9999";
  const sb = b.occurrence ? effectiveStart(b.occurrence) : "9999";
  return sa.localeCompare(sb) || a.rank - b.rank;
}

/** Next festivals within the rolling 12 months, soonest first. */
export function upcoming(entries: readonly FestivalEntry[], today: ISO, limit: number): FestivalEntry[] {
  const horizon = addMonths(today, 12);
  return entries
    .filter((e) => e.occurrence && effectiveStart(e.occurrence) < horizon && e.occurrence.status !== "cancelada")
    .sort(sortByDate)
    .slice(0, limit);
}

/** Filters over the rolling 12 months (or the travel dates when given). */
export function applyFilters(entries: readonly FestivalEntry[], filters: Filters, today: ISO): FilterHit[] {
  const from = filters.from ?? today;
  const to = filters.to ?? addMonths(today, 12);
  const hits: FilterHit[] = [];
  for (const entry of entries) {
    if (filters.types?.length && !filters.types.includes(entry.festival.type)) continue;
    const occs = occurrencesBetween(entry.festival, from, to, ctxForEntry(entry, entries));
    const occ = occs.find((o) => !filters.months?.length || filters.months.includes(effectiveStart(o).slice(0, 7)));
    if (!occ) continue;
    hits.push({ entry, occurrence: occ, possible: !occ.start });
  }
  return hits.sort(
    (a, b) => effectiveStart(a.occurrence).localeCompare(effectiveStart(b.occurrence)) || a.entry.rank - b.entry.rank,
  );
}

function ctxForEntry(entry: FestivalEntry, all: readonly FestivalEntry[]): RuleContext {
  const sameCountry = all.filter((e) => e.country === entry.country).map((e) => e.festival);
  return ctxFor({ country: entry.country, status: "publicado", generated_at: "1970-01-01", timezone: entry.festival.timezone, region: entry.region, festivals: sameCountry });
}
