// Date rules engine (PRD «Reglas de fechas»). Every date is a civil day "YYYY-MM-DD" in the
// festival's own zone; arithmetic runs on UTC midnights so the viewer's zone can never shift a day.
import type { Confidence, Edition, Festival, Rule, Status } from "./schema.ts";

export type ISO = string;

export interface CivilDate {
  y: number;
  m: number;
  d: number;
}

export interface DateWindow {
  start: ISO;
  end: ISO;
}

export type Resolved =
  | { kind: "computed" | "table"; start: ISO; end: ISO; estimated: boolean }
  | { kind: "window"; window: DateWindow };

export interface RuleContext {
  /** Resolves another festival's dates for `relative_to` rules. */
  resolveRef: (slug: string, year: number) => Resolved | null;
}

export interface Occurrence {
  year: number;
  start?: ISO;
  end?: ISO;
  window?: DateWindow;
  status: Status;
  confidence: Confidence;
  /** Moon-dependent date not yet officially announced (RF-19). */
  estimated: boolean;
  origin: "edition" | "rule";
  edition?: Edition;
}

const DAY_MS = 86_400_000;

export function parseISODate(iso: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Invalid civil date: ${iso}`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    throw new Error(`Invalid civil date: ${iso}`);
  }
  return { y, m, d };
}

export function toISODate(y: number, m: number, d: number): ISO {
  const t = new Date(Date.UTC(y, m - 1, d));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** UTC epoch ms of the civil day, for arithmetic and Intl formatting with timeZone "UTC". */
export function toUTCms(iso: ISO): number {
  const { y, m, d } = parseISODate(iso);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso: ISO, days: number): ISO {
  const { y, m, d } = parseISODate(iso);
  return toISODate(y, m, d + days);
}

export function addMonths(iso: ISO, months: number): ISO {
  const { y, m, d } = parseISODate(iso);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return toISODate(y, m + months, Math.min(d, lastDay));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: ISO, b: ISO): number {
  return Math.round((toUTCms(b) - toUTCms(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(iso: ISO): number {
  return new Date(toUTCms(iso)).getUTCDay();
}

export function overlaps(a: DateWindow, b: DateWindow): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Easter Sunday as a Gregorian civil date. Orthodox uses the Julian computus, then converts. */
export function easter(year: number, calendar: "gregorian" | "orthodox"): ISO {
  if (calendar === "orthodox") {
    const a = year % 4;
    const b = year % 7;
    const c = year % 19;
    const d = (19 * c + 15) % 30;
    const e = (2 * a + 4 * b - d + 34) % 7;
    const month = Math.floor((d + e + 114) / 31);
    const day = ((d + e + 114) % 31) + 1;
    const julianToGregorian = Math.floor(year / 100) - Math.floor(year / 400) - 2;
    return toISODate(year, month, day + julianToGregorian);
  }
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toISODate(year, month, day);
}

/** n-th (1..5) or last (-1) given weekday of a month; null when the month has no such day. */
export function nthWeekday(year: number, month: number, dow: number, n: number): ISO | null {
  if (n === -1) {
    const last = toISODate(year, month + 1, 0);
    return addDays(last, -((weekday(last) - dow + 7) % 7));
  }
  const first = toISODate(year, month, 1);
  const date = addDays(first, ((dow - weekday(first) + 7) % 7) + (n - 1) * 7);
  return parseISODate(date).m === month ? date : null;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * A month-day in a year. 02-29 in a common year is no date at all: null for an exact rule (the
 * festival has no edition that year), 02-28 for a probable window (`clampLeapDay`).
 */
function monthDay(year: number, md: string, clampLeapDay: boolean): ISO | null {
  if (md === "02-29" && !isLeapYear(year)) return clampLeapDay ? `${year}-02-28` : null;
  const iso = `${String(year).padStart(4, "0")}-${md}`;
  parseISODate(iso); // throws on a month-day the schema should have rejected (04-31)
  return iso;
}

function spanFrom(year: number, startMD: string, endMD: string, clampLeapDay: boolean): DateWindow | null {
  const start = monthDay(year, startMD, clampLeapDay);
  const end = endMD < startMD ? monthDay(year + 1, endMD, clampLeapDay) : monthDay(year, endMD, clampLeapDay);
  return start && end ? { start, end } : null;
}

export function parityMatches(rule: Rule, year: number): boolean {
  if (!rule.parity) return true;
  return rule.parity === "even" ? year % 2 === 0 : year % 2 !== 0;
}

/** Applies a rule for an edition year. Null means no edition that year, or no data to compute it. */
export function resolveRule(rule: Rule, year: number, ctx: RuleContext): Resolved | null {
  if (!parityMatches(rule, year)) return null;
  switch (rule.type) {
    case "fixed": {
      const span = spanFrom(year, rule.start, rule.end, false);
      return span ? { kind: "computed", ...span, estimated: false } : null;
    }
    case "easter_offset": {
      const sunday = easter(year, rule.calendar);
      return { kind: "computed", start: addDays(sunday, rule.start), end: addDays(sunday, rule.end), estimated: false };
    }
    case "nth_weekday": {
      const start = nthWeekday(year, rule.month, rule.weekday, rule.n);
      return start ? { kind: "computed", start, end: addDays(start, rule.duration_days - 1), estimated: false } : null;
    }
    case "relative_to": {
      const ref = ctx.resolveRef(rule.ref, year);
      if (!ref || ref.kind === "window") return null;
      const start = addDays(rule.anchor === "start" ? ref.start : ref.end, rule.offset);
      return { kind: "computed", start, end: addDays(start, rule.duration_days - 1), estimated: false };
    }
    case "lunisolar_table": {
      const row = rule.table[String(year)];
      return row ? { kind: "table", start: row.start, end: row.end, estimated: rule.sighting_dependent } : null;
    }
    case "announced": {
      const window = spanFrom(year, rule.window.start, rule.window.end, true);
      return window ? { kind: "window", window } : null;
    }
  }
}

/**
 * Whether the rule resolves to exact days (`computed`, `table`) rather than a probable window. So an
 * occurrence's `window` holds the rule's own days unless the rule is «announced».
 */
export function ruleGivesDays(rule: Rule): boolean {
  switch (rule.type) {
    case "announced":
      return false;
    case "fixed":
    case "easter_offset":
    case "nth_weekday":
    case "relative_to":
    case "lunisolar_table":
      return true;
  }
}

/** One edition of a festival: stored data wins over the rule (PRD: organizer beats rule). */
export function occurrenceFor(festival: Festival, year: number, ctx: RuleContext): Occurrence | null {
  if (!parityMatches(festival.rule, year)) return null;
  const edition = festival.editions[String(year)];
  const resolved = resolveRule(festival.rule, year, ctx);
  const moonDependent = festival.rule.type === "lunisolar_table" && festival.rule.sighting_dependent;

  if (edition?.start && edition.end) {
    return {
      year,
      start: edition.start,
      end: edition.end,
      status: edition.status,
      confidence: edition.confidence,
      estimated: moonDependent && edition.confidence !== "oficial",
      origin: "edition",
      edition,
    };
  }
  const window = resolved ? (resolved.kind === "window" ? resolved.window : { start: resolved.start, end: resolved.end }) : undefined;
  // An edition without stored dates: a tentative one keeps the rule's dates (still a pattern);
  // postponed, cancelled or unannounced ones only keep the window.
  if (edition) {
    if (edition.status === "tentativa" && resolved && resolved.kind !== "window") {
      const confidence = resolved.estimated ? "estimacion" : "patron";
      return { year, start: resolved.start, end: resolved.end, status: "tentativa", confidence, estimated: resolved.estimated, origin: "edition", edition };
    }
    return { year, ...(window ? { window } : {}), status: edition.status, confidence: edition.confidence, estimated: false, origin: "edition", edition };
  }
  if (!resolved) return { year, status: "por_anunciar", confidence: "estimacion", estimated: false, origin: "rule" };
  if (resolved.kind === "window") {
    return { year, window: resolved.window, status: "por_anunciar", confidence: "patron", estimated: false, origin: "rule" };
  }
  return {
    year,
    start: resolved.start,
    end: resolved.end,
    status: "tentativa",
    confidence: resolved.estimated ? "estimacion" : "patron",
    estimated: resolved.estimated,
    origin: "rule",
  };
}

/** Last civil day an occurrence can still be lived (dates, else the window, else the year). */
export function effectiveEnd(occ: Occurrence): ISO {
  return occ.end ?? occ.window?.end ?? `${occ.year}-12-31`;
}

export function effectiveStart(occ: Occurrence): ISO {
  return occ.start ?? occ.window?.start ?? `${occ.year}-01-01`;
}

/** Civil "today" in an IANA zone. `now` is injectable for tests. */
export function todayIn(timeZone: string, now: Date = new Date()): ISO {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatDayMonth(iso: ISO, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(toUTCms(iso));
}

export function formatDateRange(start: ISO, end: ISO, locale: string, withYear = true): string {
  const fmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
  return start === end ? fmt.format(toUTCms(start)) : fmt.formatRange(toUTCms(start), toUTCms(end));
}

export function formatMonth(iso: ISO, locale: string, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(locale, { month: style, year: "numeric", timeZone: "UTC" }).format(toUTCms(iso));
}
