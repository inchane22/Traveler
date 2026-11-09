// Data access for the screens: the index first, then only the country files a view needs
// (lazy, cached per country). Scores come from config/scoring.json bundled by Vite.
import type { PublicIndex, IndexCountry, IndexRequest } from "../../scripts/build-data.ts";
import { addDays, addMonths, diffDays, effectiveEnd, effectiveStart, type ISO, type Occurrence } from "../dates.ts";
import { applyFilters, buildEntries, isPendingPostponement, isVisible, sortByDate, type FestivalEntry, type FilterHit, type Filters, type Scope } from "../festivals.ts";
import type { ChangelogEntry, CountryFile, FestivalType, KeyEvent, Source } from "../schema.ts";
import type { ScoringConfig } from "../score.ts";
import { STATUS_TRAITS } from "../status.ts";
import scoringJson from "../../config/scoring.json";
import { origins as advisoryOrigins } from "../../config/advisories.json";
import { parseOrigins, pickAdvisory, type Advisory } from "./advisory.ts";

export type { PublicIndex, IndexCountry, IndexRequest };

export const scoring = scoringJson as ScoringConfig;
export const BASE = import.meta.env.BASE_URL;
export const STALE_DAYS = 30;
/** Below this share of dates backed by an A source, a country shows «cobertura parcial» (PRD R2). */
export const PARTIAL_SHARE = 0.6;
/** The world view names the live countries while there are at most this many; then it counts them. */
export const LIVE_NAMES_MAX = 8;

export class DataError extends Error {
  readonly kind: "offline" | "missing" | "invalid";
  constructor(kind: "offline" | "missing" | "invalid", message: string) {
    super(message);
    this.kind = kind;
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  } catch {
    throw new DataError("offline", `network error for ${path}`);
  }
  if (res.status === 404) throw new DataError("missing", `${path} not found`);
  if (!res.ok) throw new DataError("offline", `${path}: HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new DataError("invalid", `${path} is not JSON`);
  }
}

function isIndex(v: unknown): v is PublicIndex {
  const x = v as PublicIndex;
  return typeof x === "object" && x !== null && Array.isArray(x.countries) && Array.isArray(x.tier1) && typeof x.slugs === "object";
}

function isCountryFile(v: unknown, code: string): v is CountryFile {
  const x = v as CountryFile;
  return typeof x === "object" && x !== null && x.country === code && Array.isArray(x.festivals);
}

let indexPromise: Promise<PublicIndex> | null = null;
const countryPromises = new Map<string, Promise<CountryFile>>();
const entryCache = new Map<string, FestivalEntry[]>();
let changelogPromise: Promise<ChangelogEntry[]> | null = null;

export function loadIndex(): Promise<PublicIndex> {
  indexPromise ??= getJson<unknown>("data/index.json").then((v) => {
    if (!isIndex(v)) throw new DataError("invalid", "data/index.json has an unexpected shape");
    // An index cached by the service worker before requests existed has none.
    return { ...v, requests: Array.isArray(v.requests) ? v.requests : [] };
  });
  indexPromise.catch(() => {
    indexPromise = null;
  });
  return indexPromise;
}

export function loadCountry(code: string): Promise<CountryFile> {
  const cc = code.toUpperCase();
  let p = countryPromises.get(cc);
  if (!p) {
    p = getJson<unknown>(`data/countries/${cc.toLowerCase()}.json`).then((v) => {
      if (!isCountryFile(v, cc)) throw new DataError("invalid", `data for ${cc} has an unexpected shape`);
      return v;
    });
    countryPromises.set(cc, p);
    p.catch(() => countryPromises.delete(cc));
  }
  return p;
}

export function loadChangelog(): Promise<ChangelogEntry[]> {
  changelogPromise ??= getJson<unknown>("data/changelog.json")
    .then((v) => (Array.isArray(v) ? (v as ChangelogEntry[]) : []))
    .catch((err: unknown) => {
      changelogPromise = null;
      if (err instanceof DataError && err.kind === "missing") return [];
      throw err;
    });
  return changelogPromise;
}

export function entriesFor(country: CountryFile, today: ISO): FestivalEntry[] {
  const key = `${country.country}|${today}`;
  let entries = entryCache.get(key);
  if (!entries) {
    entries = buildEntries(country, scoring, today);
    entryCache.set(key, entries);
  }
  return entries;
}

export function published(index: PublicIndex): IndexCountry[] {
  return index.countries;
}

export function countryInfo(index: PublicIndex, code: string): IndexCountry | undefined {
  return index.countries.find((c) => c.code === code);
}

/** Where the build of a requested country stands; undefined when nobody asked for it. */
export function requestFor(index: PublicIndex, code: string): IndexRequest | undefined {
  return index.requests.find((r) => r.code === code);
}

/** Country files a scope needs: one for a country, its members for a region, tier-1 owners for the world. */
export function countriesFor(index: PublicIndex, scope: Scope, tier2: boolean): string[] {
  if (scope.kind === "country") return countryInfo(index, scope.code) ? [scope.code] : [];
  const inScope = index.countries.filter((c) => scope.kind === "world" || c.region === scope.region).map((c) => c.code);
  if (tier2) return inScope;
  const withTier1 = new Set(index.tier1.map((id) => id.split("/")[0]));
  return inScope.filter((c) => withTier1.has(c));
}

export interface ScopeData {
  index: PublicIndex;
  countries: CountryFile[];
  entries: FestivalEntry[];
}

export async function loadScope(scope: Scope, tier2: boolean, today: ISO): Promise<ScopeData> {
  const index = await loadIndex();
  const countries = await Promise.all(countriesFor(index, scope, tier2).map(loadCountry));
  const entries = countries.flatMap((c) => entriesFor(c, today)).filter((e) => isVisible(e, scope, tier2));
  return { index, countries, entries };
}

export interface FestivalData {
  index: PublicIndex;
  country: CountryFile;
  entry: FestivalEntry;
  entries: FestivalEntry[];
}

export async function loadFestival(slug: string, today: ISO): Promise<FestivalData | null> {
  const index = await loadIndex();
  const code = index.slugs[slug];
  if (!code) return null;
  const country = await loadCountry(code);
  const entries = entriesFor(country, today);
  const entry = entries.find((e) => e.festival.slug === slug);
  return entry ? { index, country, entry, entries } : null;
}

/** Saved slugs resolved to entries (unknown slugs are reported, not silently kept). */
export async function loadSaved(slugs: readonly string[], today: ISO): Promise<{ entries: FestivalEntry[]; missing: string[] }> {
  const index = await loadIndex();
  const codes = [...new Set(slugs.map((s) => index.slugs[s]).filter((c): c is string => !!c))];
  const countries = await Promise.all(codes.map(loadCountry));
  const all = countries.flatMap((c) => entriesFor(c, today));
  const entries = slugs.map((s) => all.find((e) => e.festival.slug === s)).filter((e): e is FestivalEntry => !!e);
  return { entries: [...entries].sort(sortByDate), missing: slugs.filter((s) => !entries.some((e) => e.festival.slug === s)) };
}

// ---------- View-model helpers ----------

export type DateKind = "dated" | "window" | "none";

export function dateKind(occ: Occurrence | null): DateKind {
  if (!occ) return "none";
  if (occ.start && occ.end) return "dated";
  return occ.window ? "window" : "none";
}

/** Unconfirmed dates carry the hatch: anything not «confirmada», plus moon estimates. */
export function isUnconfirmed(occ: Occurrence | null): boolean {
  return !occ || occ.status !== "confirmada" || occ.estimated;
}

export type Countdown =
  /** approx: only a probable window; tentative: dated, but not confirmed (or a moon estimate). */
  | { kind: "days"; days: number; approx: boolean; tentative: boolean }
  | { kind: "today" }
  | { kind: "ongoing"; daysLeft: number }
  | { kind: "ended" }
  | { kind: "postponed" }
  | { kind: "cancelled" }
  | { kind: "unknown" };

export function countdown(occ: Occurrence | null, today: ISO): Countdown {
  if (!occ) return { kind: "unknown" };
  // Its days are the ones it will not have: no count towards them (src/status.ts).
  if (!STATUS_TRAITS[occ.status].takesPlace) return { kind: "cancelled" };
  // Its old window says nothing about when it happens now: not «ended», a new date is coming.
  if (isPendingPostponement(occ)) return { kind: "postponed" };
  const start = occ.start ?? occ.window?.start;
  const end = occ.end ?? occ.window?.end;
  if (!start || !end) return { kind: "unknown" };
  const approx = !occ.start;
  // An exact day count would overstate a date nobody has confirmed: it reads «en unos N días».
  const tentative = !approx && isUnconfirmed(occ);
  if (end < today) return { kind: "ended" };
  if (start > today) return { kind: "days", days: diffDays(today, start), approx, tentative };
  if (start === today && !approx) return { kind: "today" };
  if (approx) return { kind: "days", days: 0, approx, tentative: false };
  return { kind: "ongoing", daysLeft: diffDays(today, end) };
}

export function primarySource(occ: Occurrence | null): Source | undefined {
  return occ?.edition?.sources[0];
}

const QUOTE_LANGS = ["es", "pt", "en"] as const;
const monthNames = new Map<number, string[]>();

function namesOfMonth(month: number): string[] {
  let names = monthNames.get(month);
  if (!names) {
    names = [...new Set(QUOTE_LANGS.map((lang) => new Intl.DateTimeFormat(lang, { month: "long", timeZone: "UTC" }).format(Date.UTC(2023, month - 1, 1)).toLocaleLowerCase()))];
    monthNames.set(month, names);
  }
  return names;
}

/** The quote names that civil day: the ISO form, or the day number and the month's name («9 de agosto», «6, 7, 8 y 9 de febrero», «August 9»). */
export function quoteMentions(quote: string | undefined, iso: ISO): boolean {
  if (!quote) return false;
  if (quote.includes(iso)) return true;
  const text = quote.toLocaleLowerCase();
  const day = String(Number(iso.slice(8, 10)));
  if (!new RegExp(`(^|\\D)0?${day}(\\D|$)`).test(text)) return false;
  return namesOfMonth(Number(iso.slice(5, 7))).some((name) => text.includes(name));
}

/** First source whose quote names one of these days (and, when given, one of these names). */
export function sourceQuoting(sources: readonly Source[], days: readonly ISO[], names: readonly string[] = []): Source | undefined {
  const fold = (v: string): string => v.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const wanted = names.map(fold).filter(Boolean);
  return sources.find((s) => days.some((d) => quoteMentions(s.quote, d)) && (!wanted.length || wanted.some((n) => fold(s.quote ?? "").includes(n))));
}

/**
 * The source of the dates shown, only when the edition stores its own dates. An edition without
 * dates (a tentative one, or a postponed one keeping the window) shows the rule's dates, and its
 * sources back the status, not those days. Among the sources, the first that quotes the start or
 * the end wins; the edition's first source is the fallback.
 */
export function dateSource(occ: Occurrence | null): Source | undefined {
  const edition = occ?.edition;
  if (!edition?.start || !edition.end) return undefined;
  return sourceQuoting(edition.sources, [edition.start, edition.end]) ?? primarySource(occ);
}

/**
 * The source a key-event date opens. KeyEvent stores no source of its own, so: none for a date by
 * pattern or estimate (it never borrows the publisher of the edition, even when that page lists
 * the festival's days); else a source whose quote names the event and its day (a quote that only
 * gives the festival's range does not back a parade on its last day); else the edition's first
 * source only when the event is as certain as the edition. Without one, the date shows as plain
 * text with its confidence mark.
 */
export function eventSource(event: KeyEvent, occ: Occurrence | null): Source | undefined {
  const edition = occ?.edition;
  if (!edition || !event.date || (event.confidence !== "oficial" && event.confidence !== "prensa")) return undefined;
  const days = event.end && event.end !== event.date ? [event.date, event.end] : [event.date];
  const quoted = sourceQuoting(edition.sources, days, Object.values(event.name).filter((n): n is string => typeof n === "string"));
  if (quoted) return quoted;
  return event.confidence === edition.confidence ? primarySource(occ) : undefined;
}

/** Days since a civil date; null when the date is unknown. */
export function ageInDays(iso: ISO | null | undefined, today: ISO): number | null {
  return iso ? Math.max(0, diffDays(iso, today)) : null;
}

export function isStale(lastVerified: ISO | null | undefined, today: ISO): boolean {
  const age = ageInDays(lastVerified, today);
  return age === null || age > STALE_DAYS;
}

/** The rolling 12 months the home timeline shows: first day of this month to the same day next year. */
export function timelineDomain(today: ISO): { start: ISO; end: ISO } {
  const start = `${today.slice(0, 7)}-01`;
  return { start, end: addMonths(start, 12) };
}

export function timelineHits(entries: readonly FestivalEntry[], today: ISO): FilterHit[] {
  const { end } = timelineDomain(today);
  return applyFilters(entries, { from: today, to: addDays(end, -1) }, today);
}

/** The next 12 month keys (YYYY-MM) starting with today's month. */
export function rollingMonths(today: ISO): string[] {
  const first = `${today.slice(0, 7)}-01`;
  return Array.from({ length: 12 }, (_, i) => addMonths(first, i).slice(0, 7));
}

export function hitSpan(hit: FilterHit): { start: ISO; end: ISO } {
  return { start: effectiveStart(hit.occurrence), end: effectiveEnd(hit.occurrence) };
}

export function filtersFrom(state: { months: readonly string[]; types: readonly FestivalType[]; from?: ISO; to?: ISO }): Filters {
  return {
    ...(state.months.length ? { months: state.months } : {}),
    ...(state.types.length ? { types: state.types } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
  };
}

/** Great-circle distance in km (RF-14: computed on the device, nothing leaves it). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}

// ---------- Travel advisories (R6): only `origins` is imported, so Vite drops `unverified` from the bundle ----------

const advisoryTable = parseOrigins(advisoryOrigins);

/** Origins with at least one verified official page; Ajustes names them so a gap is never silent. */
export function coveredOrigins(): string[] {
  return Object.entries(advisoryTable)
    .filter(([, o]) => o.fallback !== null || Object.keys(o.destinations).length > 0)
    .map(([code]) => code)
    .sort();
}

/** Official page of the user's origin country for this destination (see advisory.ts). */
export function advisoryFor(origin: string | null, destination: string): Advisory | null {
  return pickAdvisory(advisoryTable, origin, destination);
}
