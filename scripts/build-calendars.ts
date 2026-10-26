// Per-country subscription feeds (RF-10, RF-18): public/calendars/<cc>.ics (es), <cc>.en.ics, <cc>.pt.ics.
// Window: 2 months back (a recent cancellation still reaches subscribers) to 12 months ahead.
// Strings come from locales/<lang>.json; a missing key fails the build, so nothing unconfirmed
// is ever published without its «[Por confirmar]» mark. DTSTAMP = the country's generated_at.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addMonths, todayIn, toUTCms, type ISO } from "../src/dates.ts";
import { buildEntries, ctxFor, isVisible, occurrencesBetween } from "../src/festivals.ts";
import { buildCalendar, calendarPath, countryName, eventFor, formatDtstamp, type IcsEvent, type Translate } from "../src/ics.ts";
import { Confidence, ISODate, Lang, Status, type CountryFile } from "../src/schema.ts";
import type { ScoringConfig } from "../src/score.ts";
import { loadCountries } from "./build-data.ts";

export const LANGS: readonly Lang[] = Lang.options;
export const MONTHS_BACK = 2;
export const MONTHS_AHEAD = 12;
export const DEFAULT_SITE_URL = "https://inchane22.github.io/traveler/";

/** Every locale key the calendar code reads (docs/architecture.md, ics.ts API). */
export const REQUIRED_KEYS: readonly string[] = [
  "ics.prefix.tentative",
  "ics.prefix.cancelled",
  "ics.prefix.postponed",
  "ics.description",
  "ics.calendarName",
  ...Status.options.map((s) => `status.${s}`),
  ...Confidence.options.map((c) => `confidence.${c}`),
];

/** A parsed locales/<lang>.json: flat ("ics.prefix.tentative") or nested ({ ics: { prefix: … } }). */
export type Messages = Record<string, unknown>;

export interface CalendarFile {
  /** Relative to the output root, e.g. "calendars/co.en.ics". */
  path: string;
  content: string;
  events: number;
}

export interface BuildOptions {
  countries: readonly CountryFile[];
  config: ScoringConfig;
  messages: Record<Lang, Messages>;
  siteUrl: string;
  includeDrafts: boolean;
  /** Fixed «today» for every country; defaults to each country's civil date. */
  today?: ISO;
}

export function lookup(messages: Messages, key: string): string | undefined {
  const flat = messages[key];
  if (typeof flat === "string") return flat;
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function missingKeys(messages: Messages): string[] {
  return REQUIRED_KEYS.filter((key) => !lookup(messages, key)?.trim());
}

export function makeTranslator(messages: Messages, lang: Lang): Translate {
  return (key, params) => {
    const template = lookup(messages, key);
    if (template === undefined) throw new Error(`locales/${lang}.json: missing "${key}"`);
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match));
  };
}

export function loadMessages(dir: string): Record<Lang, Messages> {
  const read = (lang: Lang): Messages => {
    const file = join(dir, `${lang}.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`build-calendars: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`build-calendars: ${file} is not a JSON object`);
    return parsed as Messages;
  };
  return { es: read("es"), en: read("en"), pt: read("pt") };
}

export function calendarWindow(today: ISO): { from: ISO; to: ISO } {
  return { from: addMonths(today, -MONTHS_BACK), to: addMonths(today, MONTHS_AHEAD) };
}

export function parseToday(argv: readonly string[]): ISO | undefined {
  const arg = argv.find((a) => a.startsWith("--today="));
  if (!arg) return undefined;
  const value = arg.slice("--today=".length);
  if (!ISODate.safeParse(value).success) throw new Error(`build-calendars: --today must be YYYY-MM-DD, got "${value}"`);
  return value;
}

function assertSiteUrl(siteUrl: string): void {
  let protocol = "";
  try {
    protocol = new URL(siteUrl).protocol;
  } catch {
    throw new Error(`build-calendars: SITE_URL is not a URL: "${siteUrl}"`);
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`build-calendars: SITE_URL must be http(s), got "${siteUrl}"`);
}

/** Every dated edition in the window of each festival the country view shows with tier 2 on. */
export function countryEvents(country: CountryFile, config: ScoringConfig, lang: Lang, t: Translate, today: ISO, siteUrl: string): IcsEvent[] {
  const scope = { kind: "country", code: country.country } as const;
  const ctx = ctxFor(country);
  const { from, to } = calendarWindow(today);
  return buildEntries(country, config, today)
    .filter((entry) => isVisible(entry, scope, true))
    .flatMap((entry) =>
      occurrencesBetween(entry.festival, from, to, ctx).map((occurrence) =>
        eventFor({ festival: entry.festival, occurrence, country: country.country }, lang, t, siteUrl),
      ),
    )
    .filter((event): event is IcsEvent => event !== null);
}

export function buildCountryCalendars(
  country: CountryFile,
  config: ScoringConfig,
  messages: Record<Lang, Messages>,
  today: ISO,
  siteUrl: string,
): CalendarFile[] {
  const dtstamp = formatDtstamp(new Date(toUTCms(country.generated_at)));
  return LANGS.map((lang) => {
    const t = makeTranslator(messages[lang], lang);
    const events = countryEvents(country, config, lang, t, today, siteUrl);
    const name = t("ics.calendarName", { country: countryName(country.country, lang) });
    return { path: calendarPath(country.country, lang), content: buildCalendar(events, { name, dtstamp }), events: events.length };
  });
}

export function buildAllCalendars(opts: BuildOptions): CalendarFile[] {
  assertSiteUrl(opts.siteUrl);
  const missing = LANGS.flatMap((lang) => missingKeys(opts.messages[lang]).map((key) => `${lang}: ${key}`));
  if (missing.length) throw new Error(`build-calendars: missing locale keys\n  ${missing.join("\n  ")}`);
  return opts.countries
    .filter((c) => c.status === "publicado" || opts.includeDrafts)
    .flatMap((c) => buildCountryCalendars(c, opts.config, opts.messages, opts.today ?? todayIn(c.timezone), opts.siteUrl));
}

/** Replaces <outDir>/calendars so a removed country never leaves a stale feed behind. */
export function writeCalendars(files: readonly CalendarFile[], outDir: string): void {
  rmSync(join(outDir, "calendars"), { recursive: true, force: true });
  for (const file of files) {
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const includeDrafts = process.env.INCLUDE_DRAFTS === "1";
    const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
    const files = buildAllCalendars({
      countries: loadCountries("data/countries"),
      config,
      messages: loadMessages("locales"),
      siteUrl: process.env.SITE_URL || DEFAULT_SITE_URL,
      includeDrafts,
      today: parseToday(process.argv.slice(2)),
    });
    writeCalendars(files, "public");
    const summary = files.map((f) => `${f.path} (${f.events})`).join(", ");
    console.log(`build-calendars: ${files.length} feeds written; drafts ${includeDrafts ? "included" : "excluded"}: ${summary || "none"}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
