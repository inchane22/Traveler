// UI-side formatting on top of src/dates.ts. Civil days are formatted through their UTC midnight
// with timeZone "UTC", so the viewer's zone never shifts a date.
import { diffDays, formatDateRange, formatMonth, toUTCms, type ISO } from "../dates.ts";
import type { Lang } from "../schema.ts";

const cache = new Map<string, Intl.DateTimeFormat>();

function dtf(lang: Lang, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(lang, { ...opts, timeZone: "UTC" });
    cache.set(key, f);
  }
  return f;
}

export function range(start: ISO, end: ISO, lang: Lang, withYear = true): string {
  return formatDateRange(start, end, lang, withYear);
}

export function longDate(iso: ISO, lang: Lang): string {
  return dtf(lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(toUTCms(iso));
}

export function shortDate(iso: ISO, lang: Lang): string {
  return dtf(lang, { day: "numeric", month: "short", year: "numeric" }).format(toUTCms(iso));
}

export function dayMonth(iso: ISO, lang: Lang): string {
  return dtf(lang, { day: "numeric", month: "short" }).format(toUTCms(iso));
}

export function monthLabel(iso: ISO, lang: Lang, style: "long" | "short" = "long"): string {
  return formatMonth(iso, lang, style);
}

export function monthShort(iso: ISO, lang: Lang): string {
  return dtf(lang, { month: "short" }).format(toUTCms(iso)).replace(/\.$/, "");
}

export function dayNumber(iso: ISO): string {
  return String(Number(iso.slice(8, 10)));
}

/** «hoy», «ayer», «hace 3 días» from `from` (a past civil day) to `today`. */
export function relativeDays(from: ISO, today: ISO, lang: Lang): string {
  return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(-diffDays(from, today), "day");
}

/** Narrow weekday names starting at `weekStart` (1 = Monday, 6 = Saturday, 7 = Sunday). */
export function weekdayHeaders(lang: Lang, weekStart: number): { narrow: string }[] {
  // 2023-01-01 was a Sunday; day index 0..6 = Sun..Sat.
  const first = weekStart % 7;
  return Array.from({ length: 7 }, (_, i) => {
    const dow = (first + i) % 7;
    const ms = Date.UTC(2023, 0, 1 + dow);
    return { narrow: dtf(lang, { weekday: "narrow" }).format(ms) };
  });
}

export function compactNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang, { notation: "compact", compactDisplay: "long", maximumFractionDigits: 1 }).format(n);
}

export function fullNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang).format(n);
}

export function percent(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(n);
}

/** First day of the week for a locale (Intl.Locale week info where available), else Monday. */
export function localeWeekStart(locale: string): 1 | 6 | 7 {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    const day = info?.firstDay;
    if (day === 6 || day === 7) return day;
  } catch {
    /* Intl.Locale without week data: Monday is the ISO default. */
  }
  return 1;
}
