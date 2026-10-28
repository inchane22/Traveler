// Applies accepted changes to a country file, immutably, and builds the changelog entries.
// Never deletes a festival or an edition; the result must validate as a CountryFile before it is written.
import { occurrenceFor, type Occurrence, type RuleContext } from "../../src/dates.ts";
import { ctxFor } from "../../src/festivals.ts";
import { dataProblems } from "../build-data.ts";
import { ChangelogEntry, CountryFile, type Confidence, type Edition, type Festival, type ISODate, type Source } from "../../src/schema.ts";
import type { DomainPolicy } from "./domains.ts";
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

/**
 * A change replaces the measure; a confirmation keeps the stored measure (SEC-01). A confirmation
 * from a weaker source than the stored one changes nothing, so a press article never takes the
 * place of an official source (BE-01); an equal or stronger one replaces source and quote, and the
 * stored note stays only while the source is the same. A figure needs the year its quote states;
 * without one the change cannot be applied (validate flags it, so this only guards direct callers).
 */
function applyToScore(festival: Festival, change: ReviewedChange): Festival["score"] {
  const criterion = change.field.slice("score.".length) as keyof Festival["score"];
  const source = change.quote_url ?? change.sources[0]?.url;
  const base = { confidence: change.confidence, ...(source ? { source } : {}), ...(change.quote_url ? { quote: change.quote } : {}) };
  const stored = festival.score[criterion];
  if (change.kind === "confirmation" && stored) {
    if (!source || CONF_RANK[change.confidence] < CONF_RANK[stored.confidence]) return festival.score;
    const { note, quote, ...rest } = stored;
    const sameSource = source === stored.source;
    const kept = { ...rest, confidence: change.confidence, source, ...(sameSource && note ? { note } : {}) };
    const keptQuote = change.quote_url ? change.quote : sameSource ? quote : undefined;
    return { ...festival.score, [criterion]: keptQuote ? { ...kept, quote: keptQuote } : kept } as Festival["score"];
  }
  if (criterion === "convocatoria") {
    const years = quoteYears(change.quote);
    if (!years.length) throw new Error(`${change.country}/${change.slug}: score.convocatoria quote states no year`);
    const measure = { attendance: Number(change.new), qualifier: quoteQualifier(change.quote), unit: unitOf(change.quote), year: Math.max(...years) };
    return { ...festival.score, convocatoria: { measure, ...base } };
  }
  return { ...festival.score, [criterion]: { measure: change.new, ...base } } as Festival["score"];
}

/**
 * RF-18: SEQUENCE of an edition stored for the first time. Subscribed calendars already hold the
 * rule-based event at SEQUENCE 0, so when the dates or the status they show change, the new
 * edition starts at 1. A window-only rule published no event, so there is nothing to supersede.
 */
export function firstEditionSequence(published: Occurrence | null, next: Occurrence | null): number {
  if (!published?.start || !published.end) return 0;
  const same = !!next && next.start === published.start && next.end === published.end && next.status === published.status;
  return same ? 0 : 1;
}

function applyToFestival(festival: Festival, changes: readonly ReviewedChange[], today: ISODate, archived: ReadonlyMap<string, string>, ctx: RuleContext): Festival {
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
    const updated: Edition = { ...e, sources: mergeSources(e.sources, t.sources), last_verified: today };
    const bumped = e.sequence + (t.bump ? 1 : 0);
    // Every change of dates or status bumps; a first edition also starts at 1 when it changes
    // what calendars already show from the rule, whatever kind the change was classified as.
    const first = festival.editions[key]
      ? 0
      : firstEditionSequence(occurrenceFor(festival, Number(key), ctx), occurrenceFor({ ...next, editions: { ...editions, [key]: updated } }, Number(key), ctx));
    editions[key] = { ...updated, sequence: Math.max(bumped, first) };
  }
  return { ...next, editions };
}

export interface SafeApply {
  /** Changes that apply cleanly together. */
  ok: ReviewedChange[];
  /** Changes that would break the country file, each with the validation message. */
  failed: Array<{ change: ReviewedChange; error: string }>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Trial apply before anything is reported or written (code-F2, SEC-01): when a country's accepted
 * changes do not validate together, each one is tried alone and the ones that break the file are
 * returned in `failed`, so one bad change can no longer abort the whole run. With `policies`, a
 * result that build-data's dataProblems would reject counts as broken too (BE-01); problems the
 * country already had before the changes are not blamed on them.
 */
export function trialApply(countries: readonly CountryFile[], changes: readonly ReviewedChange[], today: ISODate, policies?: ReadonlyMap<string, DomainPolicy>): SafeApply {
  const ok: ReviewedChange[] = [];
  const failed: SafeApply["failed"] = [];
  const known = new Set(countries.map((c) => c.country));
  for (const c of changes) if (!known.has(c.country)) failed.push({ change: c, error: `${c.country}: no country file` });
  for (const country of countries) {
    const mine = changes.filter((c) => c.country === country.country);
    if (!mine.length) continue;
    const before = policies ? new Set(dataProblems([country], policies, today)) : null;
    const tryApply = (subset: readonly ReviewedChange[]): void => {
      const next = applyChanges(country, subset, today);
      const added = before ? dataProblems([next], policies!, today).filter((p) => !before.has(p)) : [];
      if (added.length) throw new Error(added.join("; "));
    };
    try {
      tryApply(mine);
      ok.push(...mine);
      continue;
    } catch {
      // Falls through to one-by-one: the combined error does not say which change caused it.
    }
    const alone = mine.filter((c) => {
      try {
        tryApply([c]);
        return true;
      } catch (error) {
        failed.push({ change: c, error: message(error) });
        return false;
      }
    });
    try {
      tryApply(alone);
      ok.push(...alone);
    } catch (error) {
      for (const c of alone) failed.push({ change: c, error: `en conjunto: ${message(error)}` });
    }
  }
  return { ok, failed };
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
  const ctx = ctxFor(country);
  const next = {
    ...country,
    generated_at: today,
    festivals: country.festivals.map((f) => (bySlug.has(f.slug) ? applyToFestival(f, bySlug.get(f.slug)!, today, archived, ctx) : f)),
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
