// Language-aware date reader for quotes (R3). It never guesses a missing year: a mention without
// a year matches any year, and the rule-window check guards the year instead. Spanish, Portuguese
// and English have hand-made vocabularies; any other language reads its month names from the
// platform's CLDR data, plus the English ones, native digits, Chinese/Japanese/Korean 年月日
// dates and Thai Buddhist-era years (2570 = 2027).
import { parseISODate } from "../../src/dates.ts";
import type { Lang } from "../../src/schema.ts";
import { foldText, primaryLang } from "./lang.ts";

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

/** Range words of other common languages (folded): fr, de, it, nl, ca, pl, cs, ro, sv, da, tr, ru, el, id, vi, … */
const OTHER_RANGE = ["au", "a", "et", "jusqu", "bis", "und", "al", "e", "tot", "en", "fins", "do", "i", "az", "till", "och", "til", "og", "ile", "по", "и", "до", "έως", "και", "hingga", "sampai", "dan", "den", "đen", "va", "-"];
const OTHER_FILLER = ["du", "le", "les", "de", "des", "vom", "am", "den", "zum", "dal", "il", "dei", "van", "het", "del", "od", "ot", "με", "από", "с", "tanggal", "ngay", "tu", ","];

const ENGLISH_MONTHS = ["", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const generated = new Map<string, Record<string, number> | null>();

/**
 * Month names from CLDR for a language without a hand-made table: long and short, in both the
 * standalone form and the one used inside a date (Russian «февраля», Polish «lutego»), folded.
 * null when the platform does not know the language (it would answer in another one).
 */
function cldrMonths(lang: string): Record<string, number> | null {
  if (generated.has(lang)) return generated.get(lang)!;
  let table: Record<string, number> | null = null;
  try {
    const resolved = primaryLang(new Intl.DateTimeFormat(lang).resolvedOptions().locale);
    if (resolved === lang) {
      table = {};
      const forms: Intl.DateTimeFormatOptions[] = [{ month: "long" }, { month: "short" }, { day: "numeric", month: "long" }, { day: "numeric", month: "short" }];
      for (let m = 1; m <= 12; m++) {
        const date = new Date(Date.UTC(2021, m - 1, 15));
        for (const options of forms) {
          const part = new Intl.DateTimeFormat(lang, { ...options, timeZone: "UTC" }).formatToParts(date).find((p) => p.type === "month")?.value ?? "";
          const name = foldText(part).replace(/\.$/, "");
          // Names with digits (2月, 2월) are read by the CJK pass instead.
          if (name && !/\d/.test(name)) table[name] = m;
        }
      }
      for (let m = 1; m <= 12; m++) table[ENGLISH_MONTHS[m]!] ??= m;
    }
  } catch {
    table = null;
  }
  generated.set(lang, table);
  return table;
}

interface Vocabulary {
  months: Record<string, number>;
  range: ReadonlySet<string>;
  filler: ReadonlySet<string>;
  /** Order of a numeric date with slashes or dots: d/m/y, m/d/y or y/m/d. */
  order: "dmy" | "mdy" | "ymd";
}

const CJK = new Set(["ja", "zh", "ko"]);

function vocabulary(tag: string): Vocabulary | null {
  const lang = primaryLang(tag);
  if (lang === "es" || lang === "pt" || lang === "en") {
    return { months: MONTHS[lang], range: new Set(RANGE[lang]), filler: new Set(FILLER[lang]), order: lang === "en" ? "mdy" : "dmy" };
  }
  const months = cldrMonths(lang);
  if (!months) return null;
  return { months, range: new Set(OTHER_RANGE), filler: new Set(OTHER_FILLER), order: CJK.has(lang) ? "ymd" : "dmy" };
}

/** True when quotes in this language can be checked for a date. */
export function hasDateReader(tag: string): boolean {
  return vocabulary(tag) !== null;
}

type Token =
  | { t: "num"; v: number; raw: string }
  | { t: "month"; v: number }
  | { t: "range" }
  | { t: "full"; date: PartialDate }
  | { t: "word" };

/** Zero of each decimal digit block quotes arrive in: Arabic-Indic, Persian, Devanagari, Bengali, Thai, Lao, Myanmar, Khmer, fullwidth. */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50, 0x0ed0, 0x1040, 0x17e0, 0xff10];

function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (c) => {
    const code = c.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    return zero === undefined ? c : String(code - zero);
  });
}

const CJK_YEAR = String.raw`(?:(\d{4})\s*[年년]\s*)?`;
const CJK_MONTH = String.raw`(\d{1,2})\s*[月월]\s*`;
const CJK_DAY = String.raw`(\d{1,2})\s*[日일号號]?`;
const CJK_TO = String.raw`\s*(?:[～〜~\-–—至到]|から|부터)\s*`;

/** 2027年2月14日～18日, 2월 14일부터 18일까지, 2月14日至3月2日 → «14 - 18 february 2027» and so on. */
function cjkDates(text: string): string {
  const en = (m: string): string => ENGLISH_MONTHS[Number(m)] ?? m;
  return text
    .replace(new RegExp(`${CJK_YEAR}${CJK_MONTH}${CJK_DAY}${CJK_TO}${CJK_MONTH}${CJK_DAY}`, "g"), (_x, y = "", m1, d1, m2, d2) => ` ${d1} ${en(m1)} - ${d2} ${en(m2)} ${y} `)
    .replace(new RegExp(`${CJK_YEAR}${CJK_MONTH}${CJK_DAY}${CJK_TO}${CJK_DAY}`, "g"), (_x, y = "", m, d1, d2) => ` ${d1} - ${d2} ${en(m)} ${y} `)
    .replace(new RegExp(`${CJK_YEAR}${CJK_MONTH}${CJK_DAY}`, "g"), (_x, y = "", m, d) => ` ${d} ${en(m)} ${y} `);
}

function normalize(text: string, lang: string): string {
  let t = asciiDigits(text);
  // Before folding: NFD would split the Hangul syllables the CJK pass looks for.
  if (CJK.has(lang)) t = cjkDates(t);
  t = foldText(t);
  // Thai sources count years in the Buddhist era (CE + 543).
  if (lang === "th") t = t.replace(/\b(2[45]\d\d)\b/g, (y) => String(Number(y) - 543));
  return t
    .replace(/[‐-―−]/g, "-")
    .replace(/\b1(?:ro|er)\b/g, "1")
    .replace(/\bprimero\b/g, "1")
    .replace(/(\d+)\s*(?:st|nd|rd|th|\.?[ºª°])/g, "$1");
}

function numericDate(raw: string, order: Vocabulary["order"]): PartialDate | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const ymd = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(raw);
  if (ymd) return { y: Number(ymd[1]), m: Number(ymd[2]), d: Number(ymd[3]) };
  const sep = order === "dmy" ? /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/ : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const m = sep.exec(raw);
  if (!m) return null;
  const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return order === "mdy" ? { y, m: a, d: b } : { y, m: b, d: a };
}

function tokenize(text: string, tag: string): Token[] {
  const lang = primaryLang(tag);
  const vocab = vocabulary(lang);
  if (!vocab) return [];
  const out: Token[] = [];
  for (const raw of normalize(text, lang).match(/\d{4}-\d{2}-\d{2}|\d{4}[/.]\d{1,2}[/.]\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d+|\p{L}+|[-,]/gu) ?? []) {
    if (vocab.filler.has(raw)) continue;
    const full = numericDate(raw, vocab.order);
    if (full) out.push({ t: "full", date: full });
    else if (/^\d+$/.test(raw)) out.push({ t: "num", v: Number(raw), raw });
    else if (vocab.range.has(raw)) out.push({ t: "range" });
    else if (vocab.months[raw] !== undefined) out.push({ t: "month", v: vocab.months[raw]! });
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

/**
 * The rest of a day list from `j`: days joined by a range word («6 al 9», «9 y 10») or only by a
 * comma, which is filler («22, 23 y 24»: the comma-joined days come out adjacent). Comma-joined
 * days count only when a range word closes the list after them, unless `open` (a month that
 * follows the list confirms it: «22, 23 de enero»). Without that, «March 5, 10 bands» would be a
 * range.
 */
function dayRun(toks: Token[], first: number, j: number, open: boolean): { days: number[]; next: number } {
  const days = [first];
  let pending: number[] = [];
  let closed = j;
  for (;;) {
    const tok = toks[j];
    if (tok?.t === "range" && isDay(toks[j + 1])) {
      days.push(...pending, (toks[j + 1] as { v: number }).v);
      pending = [];
      j += 2;
      closed = j;
    } else if (isDay(tok)) {
      pending.push(tok.v);
      j += 1;
    } else break;
  }
  if (pending.length && open) return { days: [...days, ...pending], next: j };
  return { days, next: closed };
}

/** Day list then month: «6 al 9 de febrero de 2027», «6, 7 y 8 de febrero», «22, 23 y 24 de enero», «6-9 February 2027». */
function dayFirst(toks: Token[], i: number): Atom | null {
  if (!isDay(toks[i])) return null;
  const run = dayRun(toks, toks[i].v, i + 1, true);
  let j = run.next;
  const month = toks[j];
  if (month?.t !== "month") return null;
  j += 1;
  const year = isYear(toks[j]) ? toks[j++] : undefined;
  return { days: run.days, m: month.v, y: year ? (year as { v: number }).v : null, next: j };
}

/** Month then day list: «February 6-9, 2027», «January 22, 23 and 24, 2027», «febrero 6 al 9 de 2027». */
function monthFirst(toks: Token[], i: number): Atom | null {
  const month = toks[i];
  if (month?.t !== "month" || !isDay(toks[i + 1])) return null;
  const run = dayRun(toks, (toks[i + 1] as { v: number }).v, i + 2, false);
  let j = run.next;
  const year = isYear(toks[j]) ? toks[j++] : undefined;
  return { days: run.days, m: month.v, y: year ? (year as { v: number }).v : null, next: j };
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
export function parseDateMentions(text: string, lang: string): DateMention[] {
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
export function quoteStatesDate(quote: string, lang: string, iso: string, role: DateRole): boolean {
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
