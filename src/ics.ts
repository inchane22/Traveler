// RFC 5545 calendar output (RF-10, RF-18), shared by the app and scripts/build-calendars.ts.
// Pure: no DOM, no fs, no locale imports. Visible strings come from the caller's `t`.
import { addDays, parseISODate, ruleGivesDays, type DateWindow, type ISO, type Occurrence } from "./dates.ts";
import type { Festival, Lang, LocalizedText, Status } from "./schema.ts";
import { STATUS_TRAITS } from "./status.ts";

export type IcsStatus = "TENTATIVE" | "CONFIRMED" | "CANCELLED";

/** Same shape as the app's i18n `t`: looks up `key` and fills `{param}` placeholders. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface IcsEvent {
  uid: string;
  start: ISO;
  /** Inclusive civil day; DTEND is written as the day after (exclusive). */
  end: ISO;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  status: IcsStatus;
  sequence: number;
}

/** A `FestivalEntry` satisfies this, and so does one edition picked by the build step. */
export interface EventSource {
  festival: Festival;
  occurrence: Occurrence | null;
  country: string;
}

export interface CalendarOptions {
  name: string;
  /** UTC, basic format: YYYYMMDDTHHMMSSZ. */
  dtstamp: string;
}

const PRODID = "-//Traveler//Calendario de fiestas 1.0//ES";
/** How often subscribed clients should poll the feed (RFC 7986 REFRESH-INTERVAL, Outlook X-PUBLISHED-TTL). */
const REFRESH = "PT12H";
const MAX_OCTETS = 75;
const DTSTAMP_FORMAT = /^\d{8}T\d{6}Z$/;
const STATUSES: ReadonlySet<string> = new Set<IcsStatus>(["TENTATIVE", "CONFIRMED", "CANCELLED"]);

export function statusFor(status: Status): IcsStatus {
  if (status === "confirmada") return "CONFIRMED";
  if (status === "cancelada") return "CANCELLED";
  return "TENTATIVE";
}

/** Every status other than «confirmada» gets a mark in the title, so nothing unconfirmed looks final. */
function prefixKey(status: Status): string | null {
  switch (status) {
    case "confirmada":
      return null;
    case "cancelada":
      return "ics.prefix.cancelled";
    case "aplazada":
      return "ics.prefix.postponed";
    case "tentativa":
    case "por_anunciar":
      return "ics.prefix.tentative";
  }
}

function withSlash(siteUrl: string): string {
  return siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
}

function localized(text: LocalizedText | undefined, lang: Lang): string | undefined {
  return text ? (text[lang] ?? text.es) : undefined;
}

/** Country name in the requested language from the platform's CLDR data; the ISO code when unknown. */
export function countryName(code: string, lang: Lang): string {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return code;
  return new Intl.DisplayNames([lang], { type: "region", fallback: "code" }).of(upper) ?? upper;
}

/**
 * The days an event spans: the occurrence's dates. A cancelled or postponed edition stored without
 * dates keeps the days its rule gave, which is the event subscribed calendars already hold, so they
 * get the new status and SEQUENCE instead of losing the event (R9, RF-18). A probable window
 * («announced» rule) never was an event.
 */
function eventDays(festival: Festival, occurrence: Occurrence): DateWindow | null {
  if (occurrence.start && occurrence.end) return { start: occurrence.start, end: occurrence.end };
  if (STATUS_TRAITS[occurrence.status].keepsRuleDays && occurrence.window && ruleGivesDays(festival.rule)) return occurrence.window;
  return null;
}

/** One all-day event per dated occurrence (see eventDays). Window-only or missing occurrences return null. */
export function eventFor(source: EventSource, lang: Lang, t: Translate, siteUrl: string): IcsEvent | null {
  const { festival, occurrence, country } = source;
  const days = occurrence ? eventDays(festival, occurrence) : null;
  if (!occurrence || !days) return null;

  const url = `${withSlash(siteUrl)}#/fiesta/${festival.slug}`;
  const name = festival.names[lang];
  const key = prefixKey(occurrence.status);
  const prefix = key ? t(key).trim() : "";
  // A `t` that returns "" or echoes the key on a miss would ship an unmarked or garbled title.
  if (key && (!prefix || prefix === key)) throw new Error(`${festival.slug}: no translation for "${key}"; an unconfirmed event cannot be exported unmarked`);

  const description = [
    t("ics.description", {
      status: t(`status.${occurrence.status}`),
      confidence: t(`confidence.${occurrence.confidence}`),
      url,
    }),
    localized(occurrence.edition?.note, lang),
    localized(festival.street_tip, lang),
  ]
    .filter((part): part is string => !!part)
    .join("\n\n");

  return {
    uid: `${festival.slug}-${occurrence.year}@traveler`,
    start: days.start,
    end: days.end,
    summary: prefix ? `${prefix} ${name}` : name,
    description,
    location: `${festival.city}, ${countryName(country, lang)}`,
    url,
    status: statusFor(occurrence.status),
    sequence: occurrence.edition?.sequence ?? 0,
  };
}

/** TEXT value escaping (RFC 5545 3.3.11); control characters other than tab are not allowed. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, "");
}

function utf8Length(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * Folds a content line at 75 octets of UTF-8 (RFC 5545 3.1). Continuation lines start with one
 * space, which counts toward their 75. Iterates code points, so a character is never split.
 */
export function foldLine(line: string): string {
  const lines: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = utf8Length(char);
    if (octets + size > MAX_OCTETS) {
      lines.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}

/** YYYY-MM-DD → YYYYMMDD, rejecting anything that is not a real civil date. */
function compactDate(iso: ISO): string {
  parseISODate(iso);
  return iso.replaceAll("-", "");
}

export function formatDtstamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function compareEvents(a: IcsEvent, b: IcsEvent): number {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1;
  return 0;
}

function assertEvent(e: IcsEvent): void {
  parseISODate(e.start);
  parseISODate(e.end);
  if (e.end < e.start) throw new Error(`${e.uid}: end ${e.end} is before start ${e.start}`);
  if (!Number.isInteger(e.sequence) || e.sequence < 0) throw new Error(`${e.uid}: SEQUENCE must be a non-negative integer`);
  if (!STATUSES.has(e.status)) throw new Error(`${e.uid}: unknown STATUS ${e.status}`);
}

function eventLines(e: IcsEvent, dtstamp: string): string[] {
  assertEvent(e);
  return [
    "BEGIN:VEVENT",
    `UID:${escapeText(e.uid)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${compactDate(e.start)}`,
    `DTEND;VALUE=DATE:${compactDate(addDays(e.end, 1))}`,
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    // URI value type: not TEXT-escaped; the URL parser normalizes it and drops any CR/LF.
    ...(e.url ? [`URL:${new URL(e.url).href}`] : []),
    `STATUS:${e.status}`,
    `SEQUENCE:${e.sequence}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ];
}

/** A full VCALENDAR (METHOD:PUBLISH) with CRLF line endings, folded lines and events sorted by date. */
export function buildCalendar(events: readonly IcsEvent[], opts: CalendarOptions): string {
  if (!DTSTAMP_FORMAT.test(opts.dtstamp)) throw new Error(`DTSTAMP must be YYYYMMDDTHHMMSSZ, got "${opts.dtstamp}"`);
  const name = escapeText(opts.name);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${name}`,
    `X-WR-CALNAME:${name}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`,
    `X-PUBLISHED-TTL:${REFRESH}`,
    ...[...events].sort(compareEvents).flatMap((e) => eventLines(e, opts.dtstamp)),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function query(params: ReadonlyArray<readonly [string, string | undefined]>): string {
  return params
    .filter((p): p is readonly [string, string] => p[1] !== undefined && p[1] !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Google Calendar «add event» link; all-day dates with the exclusive end, like DTEND. */
export function googleCalendarUrl(e: IcsEvent): string {
  const dates = `${compactDate(e.start)}/${compactDate(addDays(e.end, 1))}`;
  const rest = query([
    ["details", e.description ?? e.url],
    ["location", e.location],
  ]);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&${query([["text", e.summary]])}&dates=${dates}${rest ? `&${rest}` : ""}`;
}

/** Outlook.com «add event» deeplink; all-day with the exclusive end date. */
export function outlookCalendarUrl(e: IcsEvent): string {
  return `https://outlook.live.com/calendar/0/deeplink/compose?${query([
    ["path", "/calendar/action/compose"],
    ["rru", "addevent"],
    ["allday", "true"],
    ["startdt", e.start],
    ["enddt", addDays(e.end, 1)],
    ["subject", e.summary],
    ["body", e.description ?? e.url],
    ["location", e.location],
  ])}`;
}

/** Path of a per-country feed inside the site: Spanish is the default file, others get a suffix. */
export function calendarPath(country: string, lang: Lang): string {
  return `calendars/${country.toLowerCase()}${lang === "es" ? "" : `.${lang}`}.ics`;
}

/** webcal:// subscription link for a country feed (Apple Calendar, Outlook desktop). */
export function webcalUrl(siteUrl: string, country: string, lang: Lang): string {
  return `${withSlash(siteUrl).replace(/^https?:\/\//, "webcal://")}${calendarPath(country, lang)}`;
}
