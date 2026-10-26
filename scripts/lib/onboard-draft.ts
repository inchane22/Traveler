// H5 onboarding: the extraction contract (OnboardingDraft) and its mapping onto src/schema.ts.
// Identity fields (names, city, subdivision, zone, coordinates) are accepted after format checks;
// every date, figure and declaration needs a validated citation or becomes «por medir» / «por anunciar».
import { z } from "zod";
import { addDays, resolveRule, type ISO } from "../../src/dates.ts";
import { Confidence, FestivalType, Rule, Status, type Edition, type Festival, type Lang, type ScoreInputs } from "../../src/schema.ts";
import { quoteStatesDate } from "./date-parser.ts";
import type { DomainPolicy } from "./domains.ts";
import { checkSources, citedTextsFor, quoteIsVerbatim, quoteNumbers, type CitedSource } from "./evidence.ts";
import { hasInjection } from "./injection.ts";
import { isSupportedLang, primaryLang } from "./lang.ts";
import type { Citation } from "./research.ts";

const Evidence = z.object({ source_url: z.string(), quote: z.string(), quote_language: z.string() }).strict();
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

/** Flat rule (easier for structured output than a union); mapped and checked against `Rule`. */
const DraftRule = z
  .object({
    type: z.enum(["fixed", "easter_offset", "nth_weekday", "announced"]),
    start_month_day: nullable(z.string()),
    end_month_day: nullable(z.string()),
    easter_calendar: nullable(z.enum(["gregorian", "orthodox"])),
    easter_start_offset: nullable(z.number().int()),
    easter_end_offset: nullable(z.number().int()),
    month: nullable(z.number().int()),
    weekday: nullable(z.number().int()),
    n: nullable(z.number().int()),
    duration_days: nullable(z.number().int()),
    parity: nullable(z.enum(["even", "odd"])),
  })
  .strict();

const Level = <T extends readonly [string, ...string[]]>(values: T) => nullable(z.object({ level: z.enum(values), evidence: Evidence }).strict());

export const DraftFestival = z
  .object({
    slug: z.string(),
    names: z.object({ local: z.string(), es: z.string(), en: z.string(), pt: z.string() }).strict(),
    city: z.string(),
    subdivision: z.string(),
    timezone: z.string(),
    coords: z.object({ lat: z.number(), lon: z.number() }).strict(),
    nearest_airport: nullable(z.string()),
    type: FestivalType,
    /** R11: where the candidate came from. */
    candidate_source: z.enum(["unesco", "cultura_turismo", "feriados", "prensa", "otro"]),
    rule: DraftRule,
    rule_evidence: nullable(Evidence),
    next_edition: nullable(
      z.object({ year: z.number().int(), start: nullable(z.string()), end: nullable(z.string()), status: Status, confidence: Confidence, evidence: nullable(Evidence) }).strict(),
    ),
    attendance: nullable(
      z
        .object({
          value: z.number().int(),
          qualifier: z.enum(["exact", "about", "more_than"]),
          unit: z.enum(["attendees", "tourists", "visitors"]),
          year: z.number().int(),
          evidence: Evidence,
        })
        .strict(),
    ),
    street: Level(["mayoria_gratis", "mixta", "mayoria_boleta"] as const),
    recognition: Level(["unesco", "nacional", "ninguna"] as const),
    connectivity: Level(["internacional", "nacional", "ninguno"] as const),
    local_size: Level(["pueblo", "intermedia", "gran_ciudad"] as const),
  })
  .strict();

export const OnboardingDraft = z.object({ country: z.string(), festivals: z.array(DraftFestival), not_found: z.array(z.string()) }).strict();
export type DraftFestival = z.infer<typeof DraftFestival>;
export type OnboardingDraft = z.infer<typeof OnboardingDraft>;
type EvidenceT = z.infer<typeof Evidence>;

export interface VerifyContext {
  citations: readonly Citation[];
  policy: DomainPolicy;
}

export interface Verified {
  source: CitedSource;
  quote: string;
  confidence: Confidence;
}

/** A fact counts only with a cited, unblocked https source whose cited text holds the quote verbatim. */
export function verifyEvidence(e: EvidenceT | null | undefined, ctx: VerifyContext): Verified | null {
  if (!e) return null;
  const check = checkSources([e.source_url], ctx.citations, ctx.policy);
  const source = check.cited[0];
  if (!source) return null;
  const texts = citedTextsFor([source], ctx.citations);
  if (!quoteIsVerbatim(e.quote, texts) || hasInjection([e.quote, ...texts]).length) return null;
  return { source, quote: e.quote, confidence: source.official ? "oficial" : "prensa" };
}

const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function toRule(r: DraftFestival["rule"]): Rule | null {
  const parity = r.parity ? { parity: r.parity } : {};
  const candidate =
    r.type === "fixed"
      ? { type: "fixed", start: r.start_month_day, end: r.end_month_day, ...parity }
      : r.type === "easter_offset"
        ? { type: "easter_offset", calendar: r.easter_calendar, start: r.easter_start_offset, end: r.easter_end_offset, ...parity }
        : r.type === "nth_weekday"
          ? { type: "nth_weekday", month: r.month, weekday: r.weekday, n: r.n, duration_days: r.duration_days, ...parity }
          : { type: "announced", window: { start: r.start_month_day, end: r.end_month_day }, ...parity };
  const parsed = Rule.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const md = (iso: ISO): string => iso.slice(5);

/** Probable window for an unverified rule: its dates ±7 days, or the whole year when it has none. */
export function probableWindow(rule: Rule | null, year: number): { start: string; end: string } {
  const resolved = rule ? resolveRule(rule, year, { resolveRef: () => null }) : null;
  if (!resolved) return { start: "01-01", end: "12-31" };
  const w = resolved.kind === "window" ? resolved.window : resolved;
  if (resolved.kind === "window") return { start: md(w.start), end: md(w.end) };
  const start = addDays(w.start, -7);
  const end = addDays(w.end, 7);
  // A window that wraps the year end stays valid: `announced` windows may cross into January.
  return MD.test(md(start)) && MD.test(md(end)) ? { start: md(start), end: md(end) } : { start: "01-01", end: "12-31" };
}

function langOf(tag: string): Lang | null {
  const p = primaryLang(tag);
  return isSupportedLang(p) ? (p as Lang) : null;
}

/** A rule is verified when its quote is cited verbatim and, for fixed dates, states the start day. */
export function verifiedRule(f: DraftFestival, ctx: VerifyContext, year: number): { rule: Rule; evidence: Verified } | null {
  const rule = toRule(f.rule);
  const evidence = verifyEvidence(f.rule_evidence, ctx);
  if (!rule || !evidence || rule.type === "announced") return null;
  if (rule.type === "fixed") {
    const lang = langOf(f.rule_evidence!.quote_language);
    if (!lang || !quoteStatesDate(evidence.quote, lang, `${year}-${rule.start}`, "any")) return null;
  }
  return { rule, evidence };
}

export function verifiedEdition(f: DraftFestival, ctx: VerifyContext, today: ISO): { year: number; edition: Edition; evidence: Verified } | null {
  const e = f.next_edition;
  if (!e?.start || !e.end || !e.evidence) return null;
  const thisYear = Number(today.slice(0, 4));
  if (e.year < thisYear || e.year > thisYear + 1 || e.start > e.end || !/^\d{4}-\d{2}-\d{2}$/.test(e.start) || !/^\d{4}-\d{2}-\d{2}$/.test(e.end)) return null;
  const evidence = verifyEvidence(e.evidence, ctx);
  const lang = langOf(e.evidence.quote_language);
  if (!evidence || !lang || !quoteStatesDate(evidence.quote, lang, e.start, "start") || !quoteStatesDate(evidence.quote, lang, e.end, "end")) return null;
  const confidence: Confidence = e.confidence === "oficial" && !evidence.source.official ? "prensa" : e.confidence;
  const status = e.status === "confirmada" || e.status === "tentativa" ? e.status : "tentativa";
  return {
    year: e.year,
    evidence,
    edition: {
      start: e.start,
      end: e.end,
      status,
      confidence,
      key_events: [],
      sources: [{ url: evidence.source.url, publisher: evidence.source.host, accessed: today, tier: evidence.source.tier, quote: evidence.quote }],
      last_verified: today,
      sequence: 0,
    },
  };
}

function level<K extends keyof ScoreInputs>(value: { level: string; evidence: EvidenceT } | null, ctx: VerifyContext): ScoreInputs[K] {
  const v = verifyEvidence(value?.evidence, ctx);
  if (!value || !v) return null;
  return { measure: value.level, confidence: v.confidence, source: v.source.url } as ScoreInputs[K];
}

/** Score inputs: a criterion without a validated citation is null («por medir»). */
export function verifiedScore(f: DraftFestival, ctx: VerifyContext): { score: ScoreInputs; sources: CitedSource[] } {
  const a = f.attendance;
  const av = verifyEvidence(a?.evidence, ctx);
  const attendanceOk = !!a && !!av && quoteNumbers(av.quote).includes(a.value) && av.quote.includes(String(a.year));
  const score: ScoreInputs = {
    convocatoria: attendanceOk ? { measure: { attendance: a.value, qualifier: a.qualifier, unit: a.unit, year: a.year }, confidence: av.confidence, source: av.source.url } : null,
    calle: level<"calle">(f.street, ctx),
    reconocimiento: f.recognition && verifyEvidence(f.recognition.evidence, ctx) && (f.recognition.level !== "unesco" || /unesco|inmaterial|intangible|imaterial/i.test(f.recognition.evidence.quote))
      ? level<"reconocimiento">(f.recognition, ctx)
      : null,
    conectividad: level<"conectividad">(f.connectivity, ctx),
    local: level<"local">(f.local_size, ctx),
  };
  const sources = [a?.evidence, f.street?.evidence, f.recognition?.evidence, f.connectivity?.evidence, f.local_size?.evidence]
    .map((e) => verifyEvidence(e, ctx)?.source)
    .filter((s): s is CitedSource => !!s);
  return { score, sources };
}

export function slugify(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

const ZONES = new Set(Intl.supportedValuesOf("timeZone"));

export interface MappedFestival {
  festival: Festival;
  verified: string[];
  porMedir: string[];
  sources: CitedSource[];
  candidateSource: DraftFestival["candidate_source"];
  datedEdition: boolean;
}

/** Draft entry → schema Festival, or a reason why it cannot be one. */
export function mapFestival(f: DraftFestival, country: string, defaultZone: string, ctx: VerifyContext, today: ISO): MappedFestival | { error: string } {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(f.slug) ? f.slug : slugify(f.names.es || f.names.local);
  if (!slug) return { error: `${f.names.local}: no slug` };
  if (!new RegExp(`^${country}-[A-Z0-9]{1,3}$`).test(f.subdivision)) return { error: `${slug}: subdivision ${f.subdivision} is not an ISO 3166-2 code of ${country}` };
  if (Math.abs(f.coords.lat) > 90 || Math.abs(f.coords.lon) > 180) return { error: `${slug}: coordinates out of range` };
  if (![f.names.local, f.names.es, f.names.en, f.names.pt, f.city].every((s) => s.trim().length > 0)) return { error: `${slug}: empty name or city` };
  const year = f.next_edition?.year ?? Number(today.slice(0, 4)) + 1;
  const rule = verifiedRule(f, ctx, year);
  const edition = verifiedEdition(f, ctx, today);
  const { score, sources } = verifiedScore(f, ctx);
  const finalRule: Rule = rule?.rule ?? { type: "announced", window: probableWindow(toRule(f.rule), year), ...(f.rule.parity ? { parity: f.rule.parity } : {}) };
  const festival: Festival = {
    slug,
    names: { local: f.names.local.trim(), es: f.names.es.trim(), en: f.names.en.trim(), pt: f.names.pt.trim() },
    city: f.city.trim(),
    subdivision: f.subdivision,
    timezone: ZONES.has(f.timezone) ? f.timezone : defaultZone,
    coords: { lat: f.coords.lat, lon: f.coords.lon },
    ...(f.nearest_airport && /^[A-Z]{3}$/.test(f.nearest_airport) ? { nearest_airport: f.nearest_airport } : {}),
    type: f.type,
    rule: finalRule,
    editions: edition ? { [String(edition.year)]: edition.edition } : {},
    score,
  };
  const criteria = Object.entries(score) as Array<[string, unknown]>;
  return {
    festival,
    verified: [...(rule ? ["rule"] : []), ...(edition ? ["dates"] : []), ...criteria.filter(([, v]) => v !== null).map(([k]) => `score.${k}`)],
    porMedir: [...(rule ? [] : ["rule"]), ...(edition ? [] : ["dates"]), ...criteria.filter(([, v]) => v === null).map(([k]) => `score.${k}`)],
    sources: [...(rule ? [rule.evidence.source] : []), ...(edition ? [edition.evidence.source] : []), ...sources],
    candidateSource: f.candidate_source,
    datedEdition: !!edition,
  };
}
