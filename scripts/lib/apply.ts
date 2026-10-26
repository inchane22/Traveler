// Applies accepted changes to a country file, immutably, and builds the changelog entries.
// Never deletes a festival or an edition; the result must validate as a CountryFile before it is written.
import { ChangelogEntry, CountryFile, type Confidence, type Edition, type Festival, type ISODate, type Source } from "../../src/schema.ts";
import { quoteQualifier, quoteYears } from "./evidence.ts";
import { keyEventId, type ReviewedChange } from "./validate.ts";

const CONF_RANK: Record<Confidence, number> = { oficial: 3, prensa: 2, patron: 1, estimacion: 0 };
const higher = (a: Confidence, b: Confidence): Confidence => (CONF_RANK[a] >= CONF_RANK[b] ? a : b);
const SEQUENCE_FIELDS = new Set(["start", "end", "status"]);

function emptyEdition(confidence: Confidence): Edition {
  return { status: "tentativa", confidence, key_events: [], sources: [], sequence: 0 };
}

/** Sources of a change, with the quote on the one that holds it and the archive copy when there is one. */
export function sourcesOf(change: ReviewedChange, today: ISODate, archived: ReadonlyMap<string, string>): Source[] {
  return change.sources.map((s) => ({
    url: s.url,
    publisher: s.host,
    accessed: today,
    tier: s.tier,
    ...(s.url === change.quote_url ? { quote: change.quote } : {}),
    ...(archived.has(s.url) ? { archive_url: archived.get(s.url)! } : {}),
  }));
}

export function mergeSources(existing: readonly Source[], incoming: readonly Source[]): Source[] {
  const byUrl = new Map(existing.map((s) => [s.url, s]));
  for (const s of incoming) {
    const prev = byUrl.get(s.url);
    byUrl.set(s.url, prev ? { ...prev, accessed: s.accessed, tier: s.tier ?? prev.tier, quote: s.quote ?? prev.quote, archive_url: s.archive_url ?? prev.archive_url } : s);
  }
  return [...byUrl.values()].map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Source);
}

function applyToEdition(edition: Edition, change: ReviewedChange): Edition {
  const isChange = change.kind === "change";
  const field = change.field;
  if (field === "start" || field === "end") {
    return { ...edition, [field]: change.new as string, confidence: isChange ? change.confidence : higher(edition.confidence, change.confidence) };
  }
  if (field === "status") return isChange ? { ...edition, status: change.new as Edition["status"] } : edition;
  if (field === "confidence") return isChange ? { ...edition, confidence: change.new as Confidence } : edition;
  if (field.startsWith("key_events.")) {
    const id = keyEventId(field);
    return {
      ...edition,
      key_events: edition.key_events.map((k) => (k.id === id ? { ...k, date: change.new as string, confidence: isChange ? change.confidence : higher(k.confidence, change.confidence) } : k)),
    };
  }
  return edition;
}

function unitOf(quote: string): "attendees" | "tourists" | "visitors" {
  const t = quote.toLowerCase();
  if (/turistas|tourists/.test(t)) return "tourists";
  if (/visitantes|visitors/.test(t)) return "visitors";
  return "attendees";
}

function applyToScore(festival: Festival, change: ReviewedChange): Festival["score"] {
  const criterion = change.field.slice("score.".length) as keyof Festival["score"];
  const source = change.quote_url ?? change.sources[0]?.url;
  const base = { confidence: change.confidence, ...(source ? { source } : {}) };
  if (criterion === "convocatoria") {
    const year = Math.max(...quoteYears(change.quote));
    const measure = { attendance: Number(change.new), qualifier: quoteQualifier(change.quote), unit: unitOf(change.quote), year };
    return { ...festival.score, convocatoria: { measure, ...base } };
  }
  return { ...festival.score, [criterion]: { measure: change.new, ...base } } as Festival["score"];
}

function applyToFestival(festival: Festival, changes: readonly ReviewedChange[], today: ISODate, archived: ReadonlyMap<string, string>): Festival {
  let next = festival;
  const touched = new Map<string, { sources: Source[]; bump: boolean }>();
  for (const change of changes) {
    if (change.field.startsWith("score.")) {
      next = { ...next, score: applyToScore(next, change) };
      continue;
    }
    const key = String(change.year);
    const edition = next.editions[key] ?? emptyEdition(change.confidence);
    next = { ...next, editions: { ...next.editions, [key]: applyToEdition(edition, change) } };
    const t = touched.get(key) ?? { sources: [], bump: false };
    touched.set(key, {
      sources: [...t.sources, ...sourcesOf(change, today, archived)],
      bump: t.bump || (change.kind === "change" && SEQUENCE_FIELDS.has(change.field)),
    });
  }
  const editions = { ...next.editions };
  for (const [key, t] of touched) {
    const e = editions[key]!;
    editions[key] = { ...e, sources: mergeSources(e.sources, t.sources), last_verified: today, sequence: e.sequence + (t.bump ? 1 : 0) };
  }
  return { ...next, editions };
}

/** New country file with the changes applied; throws when the result would not validate. */
export function applyChanges(country: CountryFile, changes: readonly ReviewedChange[], today: ISODate, archived: ReadonlyMap<string, string> = new Map()): CountryFile {
  const mine = changes.filter((c) => c.country === country.country && c.verdict === "accepted");
  if (!mine.length) return country;
  const bySlug = new Map<string, ReviewedChange[]>();
  for (const c of mine) bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c]);
  for (const slug of bySlug.keys()) {
    if (!country.festivals.some((f) => f.slug === slug)) throw new Error(`${country.country}: unknown festival ${slug}`);
  }
  const next = {
    ...country,
    generated_at: today,
    festivals: country.festivals.map((f) => (bySlug.has(f.slug) ? applyToFestival(f, bySlug.get(f.slug)!, today, archived) : f)),
  };
  const parsed = CountryFile.safeParse(next);
  if (!parsed.success) throw new Error(`${country.country}: result does not validate: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  if (parsed.data.festivals.length !== country.festivals.length) throw new Error(`${country.country}: a festival would be removed`);
  return parsed.data;
}

/** One entry per value change (confirmations only refresh last_verified and sources). */
export function changelogEntries(changes: readonly ReviewedChange[], today: ISODate): ChangelogEntry[] {
  return changes
    .filter((c) => c.verdict === "accepted" && c.kind === "change")
    .map((c) => ChangelogEntry.parse({ date: today, country: c.country, slug: c.slug, field: c.field, old: c.old, new: c.new, source_urls: c.sources.map((s) => s.url) }));
}
