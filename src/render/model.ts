// Data access for the screens: the index first, then only the country files a view needs
// (lazy, cached per country). Scores come from config/scoring.json bundled by Vite.
import type { PublicIndex, IndexCountry } from "../../scripts/build-data.ts";
import { addDays, addMonths, diffDays, effectiveEnd, effectiveStart, type ISO, type Occurrence } from "../dates.ts";
import { applyFilters, buildEntries, isVisible, sortByDate, type FestivalEntry, type FilterHit, type Filters, type Scope } from "../festivals.ts";
import type { ChangelogEntry, CountryFile, FestivalType, Source } from "../schema.ts";
import type { ScoringConfig } from "../score.ts";
import scoringJson from "../../config/scoring.json";

export type { PublicIndex, IndexCountry };

export const scoring = scoringJson as ScoringConfig;
export const BASE = import.meta.env.BASE_URL;
export const STALE_DAYS = 30;
/** Below this share of dates backed by an A source, a country shows «cobertura parcial» (PRD R2). */
export const PARTIAL_SHARE = 0.6;

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
    return v;
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
  | { kind: "days"; days: number; approx: boolean }
  | { kind: "today" }
  | { kind: "ongoing"; daysLeft: number }
  | { kind: "ended" }
  | { kind: "unknown" };

export function countdown(occ: Occurrence | null, today: ISO): Countdown {
  if (!occ) return { kind: "unknown" };
  const start = occ.start ?? occ.window?.start;
  const end = occ.end ?? occ.window?.end;
  if (!start || !end) return { kind: "unknown" };
  const approx = !occ.start;
  if (end < today) return { kind: "ended" };
  if (start > today) return { kind: "days", days: diffDays(today, start), approx };
  if (start === today && !approx) return { kind: "today" };
  if (approx) return { kind: "days", days: 0, approx };
  return { kind: "ongoing", daysLeft: diffDays(today, end) };
}

export function primarySource(occ: Occurrence | null): Source | undefined {
  return occ?.edition?.sources[0];
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

// ---------- Travel advisories (R6): config/advisories.json may not exist yet ----------

const advisoryModules = import.meta.glob("../../config/advisories.json", { eager: true, import: "default" });
const advisories = (Object.values(advisoryModules)[0] ?? null) as unknown;

export interface Advisory {
  url: string;
  publisher?: string;
}

function asAdvisory(v: unknown): Advisory | null {
  if (typeof v === "string") return { url: v };
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.url === "string") return { url: o.url, ...(typeof o.publisher === "string" ? { publisher: o.publisher } : {}) };
  }
  return null;
}

/** Official advisory page of the user's origin country, specific to the destination when listed. */
export function advisoryFor(origin: string | null, destination: string): Advisory | null {
  if (!origin || typeof advisories !== "object" || advisories === null) return null;
  const root = advisories as Record<string, unknown>;
  const table = (typeof root.origins === "object" && root.origins !== null ? root.origins : root) as Record<string, unknown>;
  const entry = table[origin] ?? table[origin.toLowerCase()];
  if (!entry || typeof entry !== "object") return asAdvisory(entry);
  const e = entry as Record<string, unknown>;
  const dests = (e.destinations ?? e.countries) as Record<string, unknown> | undefined;
  const specific = dests ? asAdvisory(dests[destination] ?? dests[destination.toLowerCase()]) : null;
  const general = asAdvisory(e.fallback ?? e.default ?? e.general ?? e);
  const pick = specific ?? general;
  if (!pick) return null;
  const publisher = pick.publisher ?? (typeof e.publisher === "string" ? e.publisher : undefined);
  return { url: pick.url, ...(publisher ? { publisher } : {}) };
}

// ---------- Resources: settled values are read synchronously, so a re-render never flashes a skeleton ----------

export interface Resource<T> {
  promise: Promise<T>;
  value?: T;
  error?: unknown;
}

const resources = new Map<string, Resource<unknown>>();

export function resource<T>(key: string, factory: () => Promise<T>): Resource<T> {
  const existing = resources.get(key) as Resource<T> | undefined;
  if (existing && existing.error === undefined) return existing;
  const created: Resource<T> = { promise: factory() };
  created.promise.then(
    (value) => {
      created.value = value;
    },
    (error: unknown) => {
      created.error = error;
    },
  );
  resources.set(key, created as Resource<unknown>);
  return created;
}

/** Forget failed loads so «Reintentar» fetches again. */
export function clearFailed(): void {
  for (const [key, r] of resources) if (r.error !== undefined) resources.delete(key);
}
