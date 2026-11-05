// Accent-, case- and language-tolerant search (RF-02): «peru», «Perú» and «Peru» find Perú,
// «brazil» finds Brasil. Country names come from Intl.DisplayNames in es, en and pt plus the
// country's own code, so no name list ships in the bundle.
import type { Lang } from "./schema.ts";

/** ISO 3166-1 alpha-2 codes for sovereign states and common territories. */
export const ISO_COUNTRIES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CD CF CG " +
  "CH CI CK CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI " +
  "GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA " +
  "LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL " +
  "NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS " +
  "ST SV SX SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

const SEARCH_LANGS: readonly Lang[] = ["es", "en", "pt"];

/** Lowercase, no diacritics, punctuation as spaces, single-spaced. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface Searchable {
  id: string;
  /** Every name the item answers to (any language). The first is the display name. */
  names: readonly string[];
}

export interface SearchHit<T extends Searchable> {
  item: T;
  score: number;
}

/** 4 exact, 3 prefix of the whole name, 2 prefix of a word, 1 substring; 0 = no match. */
export function matchScore(query: string, names: readonly string[]): number {
  const q = normalize(query);
  if (!q) return 0;
  let best = 0;
  for (const name of names) {
    const n = normalize(name);
    if (!n) continue;
    if (n === q) return 4;
    if (n.startsWith(q)) best = Math.max(best, 3);
    else if (n.split(" ").some((word) => word.startsWith(q)) || n.includes(` ${q}`)) best = Math.max(best, 2);
    else if (q.length >= 3 && n.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

/** Ranked matches; ties keep the caller's order (put published or recent items first). */
export function search<T extends Searchable>(items: readonly T[], query: string, limit = Infinity): SearchHit<T>[] {
  const scored: SearchHit<T>[] = [];
  items.forEach((item) => {
    const score = matchScore(query, item.names);
    if (score > 0) scored.push({ item, score });
  });
  return scored
    .map((hit, i) => ({ hit, i }))
    .sort((a, b) => b.hit.score - a.hit.score || a.i - b.i)
    .slice(0, limit)
    .map(({ hit }) => hit);
}

export interface CountryItem extends Searchable {
  code: string;
  /** Display name in the UI language. */
  name: string;
}

type NameOf = (lang: Lang, code: string) => string | undefined;

function displayNames(): NameOf {
  const cache = new Map<Lang, Intl.DisplayNames>();
  return (lang, code) => {
    let dn = cache.get(lang);
    if (!dn) {
      dn = new Intl.DisplayNames([lang], { type: "region", fallback: "none" });
      cache.set(lang, dn);
    }
    try {
      return dn.of(code) ?? undefined;
    } catch {
      return undefined;
    }
  };
}

const defaultNames = displayNames();

/** Country items named in `lang`, sorted by that name; unknown codes are dropped. */
export function countryItems(lang: Lang, codes: readonly string[] = ISO_COUNTRIES, nameOf: NameOf = defaultNames): CountryItem[] {
  const collator = new Intl.Collator(lang, { sensitivity: "base" });
  const items: CountryItem[] = [];
  for (const code of codes) {
    const name = nameOf(lang, code);
    if (!name || name === code) continue;
    const others = SEARCH_LANGS.map((l) => nameOf(l, code)).filter((n): n is string => !!n);
    items.push({ id: code, code, name, names: [...new Set([name, ...others, code])] });
  }
  return items.sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * Country picker order: with no query, recent countries (most recent first) then the rest;
 * with a query, the best matches, published countries winning ties.
 */
export function searchCountries(
  items: readonly CountryItem[],
  query: string,
  opts: { recent?: readonly string[]; published?: readonly string[]; limit?: number } = {},
): CountryItem[] {
  const recent = opts.recent ?? [];
  const published = new Set(opts.published ?? []);
  const rankOf = (c: CountryItem): number => {
    const r = recent.indexOf(c.code);
    if (r >= 0) return r;
    return published.has(c.code) ? recent.length : recent.length + 1;
  };
  const ordered = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rankOf(a.item) - rankOf(b.item) || a.i - b.i)
    .map(({ item }) => item);
  if (!normalize(query)) return ordered.slice(0, opts.limit ?? Infinity);
  return search(ordered, query, opts.limit).map((hit) => hit.item);
}
