// Source of truth for every data file and for the AI contract (PRD «Modelo de datos»).
// Exported to JSON Schema for the extraction call, so the contract and validation never drift.
import { z } from "zod";

const isRealDate = (s: string): boolean => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

export const ISODate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine(isRealDate, "not a calendar date");
/** Days per month in a leap year, so 02-29 is a valid month-day (resolved per year in src/dates.ts). */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
export const MonthDay = z
  .string()
  .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "expected MM-DD")
  .refine((s) => Number(s.slice(3)) <= MONTH_DAYS[Number(s.slice(0, 2)) - 1]!, "not a day of that month");
/** IANA zone the platform can format with (an unknown zone throws RangeError in todayIn). */
export const TimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone.includes("/") || zone === "UTC";
  } catch {
    return false;
  }
}, "not an IANA time zone");
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2");
export const Subdivision = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, "ISO 3166-2");
export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const HttpsUrl = z.url({ protocol: /^https$/ });
export const Lang = z.enum(["es", "en", "pt"]);

/** What kind of party it is (2026-11-09: the calendar lists parties; a solemn act is no type, see `fiesta`). */
export const FestivalType = z.enum(["carnaval", "musica", "danza", "fiesta_popular"]);
export const Status = z.enum(["confirmada", "tentativa", "por_anunciar", "aplazada", "cancelada"]);
export const Confidence = z.enum(["oficial", "prensa", "patron", "estimacion"]);
export const SourceTier = z.enum(["A", "B", "C"]);

/** Text in the data (names, tips). `es` is required; other languages fall back to it. */
export const LocalizedText = z.object({ es: z.string().min(1), en: z.string().optional(), pt: z.string().optional() }).strict();

const Parity = z.enum(["even", "odd"]).optional();

export const Rule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixed"), start: MonthDay, end: MonthDay, parity: Parity }).strict(),
  z
    .object({
      type: z.literal("easter_offset"),
      calendar: z.enum(["gregorian", "orthodox"]),
      start: z.number().int(),
      end: z.number().int(),
      parity: Parity,
    })
    .strict(),
  z
    .object({
      type: z.literal("nth_weekday"),
      month: z.number().int().min(1).max(12),
      /** 0 = Sunday … 6 = Saturday */
      weekday: z.number().int().min(0).max(6),
      /** 1..5, or -1 for the last one of the month */
      n: z.union([z.literal(-1), z.number().int().min(1).max(5)]),
      duration_days: z.number().int().min(1),
      parity: Parity,
    })
    .strict(),
  z
    .object({
      type: z.literal("relative_to"),
      ref: Slug,
      anchor: z.enum(["start", "end"]),
      offset: z.number().int(),
      duration_days: z.number().int().min(1),
      parity: Parity,
    })
    .strict(),
  z
    .object({
      type: z.literal("lunisolar_table"),
      calendar: z.enum(["hindu", "chinese", "islamic", "buddhist", "hebrew", "other"]),
      /** Dates depend on a moon sighting or a new moon near midnight (R4, RF-19). */
      sighting_dependent: z.boolean(),
      table: z.record(z.string().regex(/^\d{4}$/), z.object({ start: ISODate, end: ISODate }).strict()),
      table_source: HttpsUrl,
      parity: Parity,
    })
    .strict(),
  z.object({ type: z.literal("announced"), window: z.object({ start: MonthDay, end: MonthDay }).strict(), parity: Parity }).strict(),
]);

export const Source = z
  .object({
    url: HttpsUrl,
    publisher: z.string().min(1),
    accessed: ISODate,
    tier: SourceTier.optional(),
    /** Exact text seen at the source (R1). */
    quote: z.string().optional(),
    archive_url: HttpsUrl.optional(),
  })
  .strict();

export const KeyEvent = z
  .object({
    id: Slug,
    name: LocalizedText,
    date: ISODate.optional(),
    end: ISODate.optional(),
    /** A key event can be derived from its festival or another one (e.g. Guacherna). */
    rule: Rule.optional(),
    confidence: Confidence,
  })
  .strict();

export const Edition = z
  .object({
    start: ISODate.optional(),
    end: ISODate.optional(),
    status: Status,
    confidence: Confidence,
    key_events: z.array(KeyEvent).default([]),
    sources: z.array(Source).default([]),
    last_verified: ISODate.optional(),
    /** Bumped on every change of dates or status; feeds the .ics SEQUENCE (RF-18). */
    sequence: z.number().int().min(0).default(0),
    note: LocalizedText.optional(),
  })
  .strict()
  .refine((e) => !e.start || !e.end || e.start <= e.end, "start after end")
  .refine((e) => !["confirmada", "aplazada", "cancelada"].includes(e.status) || e.sources.length > 0, "status needs a source")
  .refine((e) => e.status !== "confirmada" || (!!e.start && !!e.end), "a confirmed edition needs start and end");

/**
 * A score figure. «oficial» and «prensa» name where the figure was read, so they need that source
 * (CLAUDE.md: every figure carries a source); an unsourced figure can only be an «estimacion».
 */
const measured = <T extends z.ZodTypeAny>(shape: T) =>
  z
    .object({
      measure: shape,
      confidence: Confidence,
      source: HttpsUrl.optional(),
      /** Exact text seen at the source, when it was recorded (R1). */
      quote: z.string().min(1).optional(),
      note: LocalizedText.optional(),
    })
    .strict()
    .refine((m) => !["oficial", "prensa"].includes(m.confidence as string) || !!m.source, "an «oficial» or «prensa» figure needs a source")
    .nullable();

/**
 * What a visitor does there (2026-11-09). «solemne» (a procession, pilgrimage, mass, passion play
 * or memorial) is not a party: the festival leaves every list (src/score.ts `isParty`).
 */
export const FiestaLevel = z.enum(["baile_abierto", "baile_y_show", "show", "solemne"]);
/** Where the crowd comes from: abroad, the rest of the country, or mostly the place and its region. */
export const ViajerosLevel = z.enum(["internacional", "nacional", "regional"]);

/** Raw measures; points come from config/scoring.json. `null` = «por medir». */
export const ScoreInputs = z
  .object({
    convocatoria: measured(
      z
        .object({
          attendance: z.number().int().min(0),
          qualifier: z.enum(["exact", "about", "more_than"]),
          unit: z.enum(["attendees", "tourists", "visitors"]),
          year: z.number().int(),
        })
        .strict(),
    ),
    fiesta: measured(FiestaLevel),
    viajeros: measured(ViajerosLevel),
    calle: measured(z.enum(["mayoria_gratis", "mixta", "mayoria_boleta"])),
    conectividad: measured(z.enum(["internacional", "nacional", "ninguno"])),
  })
  .strict();

/** Most names and cities fit in 60 characters; 120 leaves room without letting a paragraph in. */
export const IDENTITY_MAX = 120;
// Controls (Cc: C0/C1, newlines included), format characters (Cf: bidi overrides and isolates,
// zero-width marks, soft hyphen, word joiner, the U+E0000 tag block) and the line and paragraph
// separators U+2028/U+2029 (SEC-07, BE-06): identity fields go into every research prompt, so they
// stay one plain line with nothing invisible in it.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A festival name or city: one plain line, bounded. */
export const Identity = z
  .string()
  .min(1)
  .max(IDENTITY_MAX)
  .refine((s) => !HIDDEN_CHARS.test(s), "control, format (bidi, zero-width, tag) or line-separator characters are not allowed")
  .refine((s) => s.trim() === s, "leading or trailing spaces");

export const Festival = z
  .object({
    slug: Slug,
    names: z.object({ local: Identity, es: Identity, en: Identity, pt: Identity }).strict(),
    city: Identity,
    subdivision: Subdivision,
    timezone: TimeZone,
    coords: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict(),
    nearest_airport: z.string().regex(/^[A-Z]{3}$/).optional(),
    type: FestivalType,
    rule: Rule,
    editions: z.record(z.string().regex(/^\d{4}$/), Edition),
    score: ScoreInputs,
    street_tip: LocalizedText.optional(),
    etiquette: LocalizedText.optional(),
  })
  .strict();

/** PRD R2: fewer festivals with a dated, A- or B-sourced edition keeps a country in «borrador» (checked by build-data). */
export const MIN_SOURCED_FESTIVALS = 3;

export const CountryFile = z
  .object({
    country: CountryCode,
    status: z.enum(["publicado", "borrador"]),
    generated_at: ISODate,
    timezone: TimeZone,
    region: z.enum(["sudamerica", "centroamerica_caribe", "norteamerica", "europa", "asia", "africa", "oceania"]),
    festivals: z.array(Festival),
  })
  .strict()
  .superRefine((c, ctx) => {
    const slugs = new Set<string>();
    for (const f of c.festivals) {
      if (slugs.has(f.slug)) ctx.addIssue({ code: "custom", message: `duplicate slug ${f.slug}` });
      slugs.add(f.slug);
      if (!f.subdivision.startsWith(`${c.country}-`))
        ctx.addIssue({ code: "custom", message: `${f.slug}: subdivision ${f.subdivision} is not in ${c.country}` });
    }
  });

export const ChangelogEntry = z
  .object({
    date: ISODate,
    country: CountryCode,
    slug: Slug,
    field: z.string(),
    old: z.unknown(),
    new: z.unknown(),
    source_urls: z.array(HttpsUrl).min(1),
    pr: z.string().optional(),
  })
  .strict();

/** What the extraction call returns (PRD «Propuesta de la IA»). */
export const ProposalChange = z
  .object({
    field: z.string().regex(/^(start|end|status|confidence|key_events\.[a-z0-9_-]+|score\.[a-z]+)$/),
    old: z.union([z.string(), z.number(), z.null()]),
    new: z.union([z.string(), z.number(), z.null()]),
    source_urls: z.array(z.string()),
    quote: z.string(),
    quote_language: z.string(),
    confidence: Confidence,
    note: z.string(),
  })
  .strict();

export const Proposal = z
  .object({
    country: CountryCode,
    slug: Slug,
    edition: z.number().int(),
    changes: z.array(ProposalChange),
    not_found: z.array(z.string()),
  })
  .strict();

export type ISODate = z.infer<typeof ISODate>;
export type Lang = z.infer<typeof Lang>;
export type FestivalType = z.infer<typeof FestivalType>;
export type Status = z.infer<typeof Status>;
export type Confidence = z.infer<typeof Confidence>;
export type LocalizedText = z.infer<typeof LocalizedText>;
export type Rule = z.infer<typeof Rule>;
export type Source = z.infer<typeof Source>;
export type KeyEvent = z.infer<typeof KeyEvent>;
export type Edition = z.infer<typeof Edition>;
export type ScoreInputs = z.infer<typeof ScoreInputs>;
export type Festival = z.infer<typeof Festival>;
export type CountryFile = z.infer<typeof CountryFile>;
export type ChangelogEntry = z.infer<typeof ChangelogEntry>;
export type ProposalChange = z.infer<typeof ProposalChange>;
export type Proposal = z.infer<typeof Proposal>;
