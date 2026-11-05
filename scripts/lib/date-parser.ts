// Language-aware date reader for quotes in es/en/pt (R3). It never guesses a missing year: a
// mention without a year matches any year, and the rule-window check guards the year instead.
import { parseISODate } from "../../src/dates.ts";
import type { Lang } from "../../src/schema.ts";
import { foldText } from "./lang.ts";

export interface PartialDate {
  y: number | null;
  m: number;
  d: number;
}

export interface DateMention {
  start: PartialDate;
  end: PartialDate;
}

const MONTHS: Record<Lang, Record<string, number>> = {
  es: {
    enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
    julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sep: 9, sept: 9, set: 9, octubre: 10, oct: 10,
    noviembre: 11, nov: 11, diciembre: 12, dic: 12,
  },
  pt: {
    janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, mar: 3, abril: 4, abr: 4, maio: 5, mai: 5, junho: 6, jun: 6,
    julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9, outubro: 10, out: 10, novembro: 11, nov: 11,
    dezembro: 12, dez: 12,
  },
  en: {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
    july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
    december: 12, dec: 12,
  },
};

const RANGE: Record<Lang, readonly string[]> = {
  es: ["al", "a", "hasta", "y", "-"],
  pt: ["a", "ate", "e", "-"],
  en: ["to", "through", "thru", "until", "till", "and", "-"],
};

/** Words that may sit inside a date expression without breaking it. */
const FILLER: Record<Lang, readonly string[]> = {
  es: ["de", "del", "el", "la", "los", "las", "dia", "dias", "desde", "entre", "partir", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo", ","],
  pt: ["de", "do", "da", "dos", "das", "o", "os", "dia", "dias", "desde", "entre", "segunda", "terca", "quarta", "quinta", "sexta", "feira", "sabado", "domingo", ","],
  en: ["of", "the", "on", "from", "between", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", ","],
};

type Token =
  | { t: "num"; v: number; raw: string }
  | { t: "month"; v: number }
  | { t: "range" }
  | { t: "full"; date: PartialDate }
  | { t: "word" };

function normalize(text: string): string {
  return foldText(text)
    .replace(/[‐-―−]/g, "-")
    .replace(/\b1(?:ro|er)\b/g, "1")
    .replace(/\bprimero\b/g, "1")
    .replace(/(\d+)\s*(?:st|nd|rd|th|\.?[ºª°])/g, "$1");
}

function numericDate(raw: string, lang: Lang): PartialDate | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!slash) return null;
  const [a, b, y] = [Number(slash[1]), Number(slash[2]), Number(slash[3])];
  return lang === "en" ? { y, m: a, d: b } : { y, m: b, d: a };
}

function tokenize(text: string, lang: Lang): Token[] {
  const filler = new Set(FILLER[lang]);
  const range = new Set(RANGE[lang]);
  const out: Token[] = [];
  for (const raw of normalize(text).match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d+|[a-z]+|[-,]/g) ?? []) {
    if (filler.has(raw)) continue;
    const full = numericDate(raw, lang);
    if (full) out.push({ t: "full", date: full });
    else if (/^\d+$/.test(raw)) out.push({ t: "num", v: Number(raw), raw });
    else if (range.has(raw)) out.push({ t: "range" });
    else if (MONTHS[lang][raw] !== undefined) out.push({ t: "month", v: MONTHS[lang][raw]! });
    else out.push({ t: "word" });
  }
  return out;
}

const isDay = (tok: Token | undefined): tok is { t: "num"; v: number; raw: string } => tok?.t === "num" && tok.raw.length <= 2 && tok.v >= 1 && tok.v <= 31;
const isYear = (tok: Token | undefined): tok is { t: "num"; v: number; raw: string } => tok?.t === "num" && tok.raw.length === 4 && tok.v >= 1900 && tok.v <= 2100;

interface Atom {
  days: number[];
  m: number;
  y: number | null;
  next: number;
}

/** Day list then month: «6 al 9 de febrero de 2027», «6, 7 y 8 de febrero», «6-9 February 2027». */
function dayFirst(toks: Token[], i: number): Atom | null {
  if (!isDay(toks[i])) return null;
  const days = [toks[i].v];
  let j = i + 1;
  while (toks[j]?.t === "range" && isDay(toks[j + 1])) {
    days.push((toks[j + 1] as { v: number }).v);
    j += 2;
  }
  const month = toks[j];
  if (month?.t !== "month") return null;
  j += 1;
  const year = isYear(toks[j]) ? toks[j++] : undefined;
  return { days, m: month.v, y: year ? (year as { v: number }).v : null, next: j };
}

/** Month then day list: «February 6-9, 2027», «febrero 6 al 9 de 2027». */
function monthFirst(toks: Token[], i: number): Atom | null {
  const month = toks[i];
  if (month?.t !== "month" || !isDay(toks[i + 1])) return null;
  const days = [(toks[i + 1] as { v: number }).v];
  let j = i + 2;
  while (toks[j]?.t === "range" && isDay(toks[j + 1])) {
    days.push((toks[j + 1] as { v: number }).v);
    j += 2;
  }
  const year = isYear(toks[j]) ? toks[j++] : undefined;
  return { days, m: month.v, y: year ? (year as { v: number }).v : null, next: j };
}

function atomAt(toks: Token[], i: number): Atom | null {
  return dayFirst(toks, i) ?? monthFirst(toks, i);
}

function fillYears(start: PartialDate, end: PartialDate): DateMention {
  if (start.y === null && end.y !== null) return { start: { ...start, y: start.m > end.m ? end.y - 1 : end.y }, end };
  if (end.y === null && start.y !== null) return { start, end: { ...end, y: end.m < start.m ? start.y + 1 : start.y } };
  return { start, end };
}

function isReal(p: PartialDate): boolean {
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return false;
  if (p.y === null) return p.d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][p.m - 1]!;
  try {
    parseISODate(`${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`);
    return true;
  } catch {
    return false;
  }
}

/** Every date or date range the text states, in order. */
export function parseDateMentions(text: string, lang: Lang): DateMention[] {
  const toks = tokenize(text, lang);
  const out: DateMention[] = [];
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i]!;
    if (tok.t === "full") {
      const other = toks[i + 1]?.t === "range" ? toks[i + 2] : undefined;
      if (other?.t === "full") {
        out.push({ start: tok.date, end: other.date });
        i += 3;
      } else {
        out.push({ start: tok.date, end: tok.date });
        i += 1;
      }
      continue;
    }
    const atom = atomAt(toks, i);
    if (!atom) {
      i += 1;
      continue;
    }
    // Cross-month range: «30 de enero al 2 de febrero», «January 30 – February 2, 2027».
    const second = atom.days.length === 1 && toks[atom.next]?.t === "range" ? atomAt(toks, atom.next + 1) : null;
    if (second) {
      out.push(fillYears({ y: atom.y, m: atom.m, d: atom.days[0]! }, { y: second.y, m: second.m, d: second.days.at(-1)! }));
      i = second.next;
      continue;
    }
    const first = atom.days[0]!;
    const last = atom.days.at(-1)!;
    out.push({ start: { y: atom.y, m: atom.m, d: first }, end: { y: atom.y, m: atom.m, d: last } });
    i = atom.next;
  }
  return out.filter((m) => isReal(m.start) && isReal(m.end));
}

export function matchesPartial(p: PartialDate, iso: string): boolean {
  const { y, m, d } = parseISODate(iso);
  return p.m === m && p.d === d && (p.y === null || p.y === y);
}

export type DateRole = "start" | "end" | "any";

/** Does the quote state `iso` in the given role? `any` accepts a start, an end or a single day. */
export function quoteStatesDate(quote: string, lang: Lang, iso: string, role: DateRole): boolean {
  return parseDateMentions(quote, lang).some((mention) => {
    if (role === "start") return matchesPartial(mention.start, iso);
    if (role === "end") return matchesPartial(mention.end, iso);
    return matchesPartial(mention.start, iso) || matchesPartial(mention.end, iso);
  });
}

export function formatPartial(p: PartialDate): string {
  const md = `${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  return p.y === null ? `????-${md}` : `${p.y}-${md}`;
}
