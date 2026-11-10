// Country facts the pipeline needs before any data file exists, and per-language vocabulary
// for the news sweep (R9) and for status checks on quotes. Any country of the site's list has
// facts: hand-checked ones below win; the rest come from the platform's CLDR data (likely
// language and zone) plus config/regions.json, with the capital's zone where a country spans several.
import { readFileSync } from "node:fs";
import type { CountryFile, Lang } from "../../src/schema.ts";

type Region = CountryFile["region"];

export interface CountryInfo {
  lang: Lang;
  /** Language the local sources are written in (ISO 639-1), may be outside es/en/pt. */
  local: string;
  timezone: string;
  region: Region;
  names: { es: string; en: string };
}

const C = (lang: Lang, local: string, timezone: string, region: Region, es: string, en: string): CountryInfo => ({
  lang,
  local,
  timezone,
  region,
  names: { es, en },
});

/** Hand-checked facts. [assumption: capital-city zone as the country default; festivals keep their own zone] */
export const COUNTRIES: Readonly<Record<string, CountryInfo>> = {
  CO: C("es", "es", "America/Bogota", "sudamerica", "Colombia", "Colombia"),
  PE: C("es", "es", "America/Lima", "sudamerica", "Perú", "Peru"),
  BO: C("es", "es", "America/La_Paz", "sudamerica", "Bolivia", "Bolivia"),
  BR: C("pt", "pt", "America/Sao_Paulo", "sudamerica", "Brasil", "Brazil"),
  MX: C("es", "es", "America/Mexico_City", "norteamerica", "México", "Mexico"),
  AR: C("es", "es", "America/Argentina/Buenos_Aires", "sudamerica", "Argentina", "Argentina"),
  CL: C("es", "es", "America/Santiago", "sudamerica", "Chile", "Chile"),
  EC: C("es", "es", "America/Guayaquil", "sudamerica", "Ecuador", "Ecuador"),
  UY: C("es", "es", "America/Montevideo", "sudamerica", "Uruguay", "Uruguay"),
  TT: C("en", "en", "America/Port_of_Spain", "centroamerica_caribe", "Trinidad y Tobago", "Trinidad and Tobago"),
  CU: C("es", "es", "America/Havana", "centroamerica_caribe", "Cuba", "Cuba"),
  DO: C("es", "es", "America/Santo_Domingo", "centroamerica_caribe", "República Dominicana", "Dominican Republic"),
  PA: C("es", "es", "America/Panama", "centroamerica_caribe", "Panamá", "Panama"),
  // The rest of Latin America (config/pipeline.json «coverage»). CLDR's likely language is Guaraní
  // for PY and Haitian Creole for HT, which the date reader cannot read; their press writes in
  // Spanish and French.
  PY: C("es", "es", "America/Asuncion", "sudamerica", "Paraguay", "Paraguay"),
  VE: C("es", "es", "America/Caracas", "sudamerica", "Venezuela", "Venezuela"),
  CR: C("es", "es", "America/Costa_Rica", "centroamerica_caribe", "Costa Rica", "Costa Rica"),
  GT: C("es", "es", "America/Guatemala", "centroamerica_caribe", "Guatemala", "Guatemala"),
  SV: C("es", "es", "America/El_Salvador", "centroamerica_caribe", "El Salvador", "El Salvador"),
  HN: C("es", "es", "America/Tegucigalpa", "centroamerica_caribe", "Honduras", "Honduras"),
  NI: C("es", "es", "America/Managua", "centroamerica_caribe", "Nicaragua", "Nicaragua"),
  PR: C("es", "es", "America/Puerto_Rico", "centroamerica_caribe", "Puerto Rico", "Puerto Rico"),
  HT: C("en", "fr", "America/Port-au-Prince", "centroamerica_caribe", "Haití", "Haiti"),
  US: C("en", "en", "America/New_York", "norteamerica", "Estados Unidos", "United States"),
  ES: C("es", "es", "Europe/Madrid", "europa", "España", "Spain"),
  PT: C("pt", "pt", "Europe/Lisbon", "europa", "Portugal", "Portugal"),
  DE: C("en", "de", "Europe/Berlin", "europa", "Alemania", "Germany"),
  GB: C("en", "en", "Europe/London", "europa", "Reino Unido", "United Kingdom"),
  IT: C("en", "it", "Europe/Rome", "europa", "Italia", "Italy"),
  FR: C("en", "fr", "Europe/Paris", "europa", "Francia", "France"),
  IN: C("en", "hi", "Asia/Kolkata", "asia", "India", "India"),
  TH: C("en", "th", "Asia/Bangkok", "asia", "Tailandia", "Thailand"),
  JP: C("en", "ja", "Asia/Tokyo", "asia", "Japón", "Japan"),
  AU: C("en", "en", "Australia/Sydney", "oceania", "Australia", "Australia"),
  ZA: C("en", "en", "Africa/Johannesburg", "africa", "Sudáfrica", "South Africa"),
};

/** Capital-city zone for countries CLDR lists several zones for. */
export const CAPITAL_ZONES: Readonly<Record<string, string>> = {
  AR: "America/Argentina/Buenos_Aires", AU: "Australia/Sydney", BR: "America/Sao_Paulo", CA: "America/Toronto",
  CD: "Africa/Kinshasa", CL: "America/Santiago", CN: "Asia/Shanghai", CY: "Asia/Nicosia", DE: "Europe/Berlin",
  EC: "America/Guayaquil", ES: "Europe/Madrid", FM: "Pacific/Pohnpei", GL: "America/Nuuk", ID: "Asia/Jakarta",
  KI: "Pacific/Tarawa", KZ: "Asia/Almaty", MH: "Pacific/Majuro", MN: "Asia/Ulaanbaatar", MX: "America/Mexico_City",
  MY: "Asia/Kuala_Lumpur", NZ: "Pacific/Auckland", PF: "Pacific/Tahiti", PG: "Pacific/Port_Moresby", PS: "Asia/Hebron",
  PT: "Europe/Lisbon", RU: "Europe/Moscow", UA: "Europe/Kyiv", US: "America/New_York", UZ: "Asia/Tashkent",
  XK: "Europe/Belgrade",
};

/** Where CLDR has no likely language for the region. */
const LANGUAGE_OVERRIDES: Readonly<Record<string, string>> = { XK: "sq" };

const REGIONS = JSON.parse(readFileSync(new URL("../../config/regions.json", import.meta.url), "utf8")) as Record<Region, string[]>;
const REGION_OF = new Map(Object.entries(REGIONS).flatMap(([region, codes]) => codes.map((cc) => [cc, region as Region] as const)));

const derived = new Map<string, CountryInfo | null>();

function displayName(cc: string, lang: "es" | "en"): string {
  return new Intl.DisplayNames([lang], { type: "region", fallback: "code" }).of(cc) ?? cc;
}

/** Facts from CLDR: the region's likely language and its zone (or the capital's). */
export function deriveCountry(cc: string): CountryInfo | null {
  const region = REGION_OF.get(cc);
  if (!region) return null;
  const likely = new Intl.Locale(`und-${cc}`).maximize() as Intl.Locale & { timeZones?: string[]; getTimeZones?: () => string[] };
  const zones = likely.getTimeZones?.() ?? likely.timeZones ?? [];
  const timezone = CAPITAL_ZONES[cc] ?? (zones.length === 1 ? zones[0] : undefined);
  if (!timezone) return null;
  const local = LANGUAGE_OVERRIDES[cc] ?? likely.language;
  return { lang: isSupportedLang(local) ? (local as Lang) : "en", local, timezone, region, names: { es: displayName(cc, "es"), en: displayName(cc, "en") } };
}

export function countryInfo(code: string): CountryInfo | null {
  const cc = code.toUpperCase();
  const known = COUNTRIES[cc];
  if (known) return known;
  if (!derived.has(cc)) derived.set(cc, deriveCountry(cc));
  return derived.get(cc) ?? null;
}

/** Language for prompts and the site's text: the country's own when it is es/en/pt, else English; Spanish when unknown. */
export function langFor(code: string): Lang {
  return countryInfo(code)?.lang ?? "es";
}

/** Language local sources are written in (ISO 639-1), for search terms and date reading. */
export function localLangFor(code: string): string {
  return countryInfo(code)?.local ?? langFor(code);
}

/** Primary subtag of a BCP 47 tag («es-CO» → «es»), lowercase. */
export function primaryLang(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

export function isSupportedLang(tag: string): tag is Lang {
  const p = primaryLang(tag);
  return p === "es" || p === "en" || p === "pt";
}

/** R9: words that announce a suspension, in the local language and in English. */
export const NEWS_TERMS: Readonly<Record<Lang, readonly string[]>> = {
  es: ["cancelado", "aplazado", "suspendido"],
  en: ["cancelled", "postponed", "suspended"],
  pt: ["cancelado", "adiado", "suspenso"],
};

/** The same words in other languages festival sources are often written in (ISO 639-1). */
export const LOCAL_NEWS_TERMS: Readonly<Record<string, readonly string[]>> = {
  fr: ["annulé", "reporté", "suspendu"],
  de: ["abgesagt", "verschoben", "ausgesetzt"],
  it: ["annullato", "rinviato", "sospeso"],
  nl: ["afgelast", "uitgesteld", "geannuleerd"],
  ca: ["cancel·lat", "ajornat", "suspès"],
  pl: ["odwołany", "przełożony", "zawieszony"],
  cs: ["zrušen", "odložen", "přesunut"],
  ro: ["anulat", "amânat", "suspendat"],
  hu: ["elmarad", "elhalasztva", "lemondva"],
  sv: ["inställd", "uppskjuten", "avlyst"],
  da: ["aflyst", "udskudt"],
  nb: ["avlyst", "utsatt"],
  fi: ["peruttu", "siirretty", "keskeytetty"],
  el: ["ακυρώθηκε", "αναβάλλεται", "αναστέλλεται"],
  tr: ["iptal edildi", "ertelendi"],
  ru: ["отменён", "перенесён", "отменено"],
  uk: ["скасовано", "перенесено"],
  ar: ["إلغاء", "تأجيل"],
  he: ["בוטל", "נדחה"],
  hi: ["रद्द", "स्थगित"],
  th: ["ยกเลิก", "เลื่อน"],
  vi: ["hủy", "hoãn"],
  id: ["dibatalkan", "ditunda"],
  ms: ["dibatalkan", "ditangguhkan"],
  fil: ["kinansela", "ipinagpaliban"],
  ja: ["中止", "延期"],
  zh: ["取消", "延期", "停办"],
  ko: ["취소", "연기"],
  sw: ["imeahirishwa", "imefutwa"],
};

/** R9 cadence: the sweep runs for festivals 45 days out or less (daily in the last week, see H6). */
export const NEWS_SWEEP_DAYS = 45;

export function needsNewsSweep(daysToStart: number): boolean {
  return daysToStart <= NEWS_SWEEP_DAYS;
}

/**
 * Search terms for the sweep, no duplicates: for es/en/pt the language first, then English and
 * Portuguese (the pilot regions); for any other language its own words when known, then English.
 */
export function newsTerms(lang: string): string[] {
  const p = primaryLang(lang);
  if (isSupportedLang(p)) return [...new Set([...NEWS_TERMS[p as Lang], ...NEWS_TERMS.en, ...NEWS_TERMS.pt])];
  return [...new Set([...(LOCAL_NEWS_TERMS[p] ?? []), ...NEWS_TERMS.en])];
}

/** Stems (accent-free, lowercase) that make a quote say a festival was cancelled or postponed. */
const STATUS_STEMS: Readonly<Record<"cancelada" | "aplazada" | "tentativa", readonly string[]>> = {
  cancelada: [
    "cancelad", "suspendid", "cancel", "suspend", "suspens", "no se realizara", "will not take place", "nao sera realizad",
    // fr, de, it, nl, pl, ro, sv/da/nb, tr, ru/uk, ja/zh, ko (folded: no accents, lowercase)
    "annule", "abgesagt", "annullat", "afgelast", "geannuleerd", "odwolan", "anulat", "installd", "aflyst", "avlyst", "iptal",
    "отмен", "скасов", "中止", "取消", "停办", "취소",
  ],
  aplazada: [
    "aplazad", "pospuest", "postergad", "reprogramad", "postpon", "reschedul", "adiad", "remarcad",
    "est reporte", "sont reportes", "reportee", "ete reporte", "verschoben", "rinviat", "uitgesteld", "przelozon", "amanat", "uppskjut", "udskudt", "utsatt", "ertelen",
    "перенес", "延期", "연기",
  ],
  tentativa: [
    "por confirmar", "por definir", "a confirmar", "sin confirmar", "tentativ", "provisional", "por anunciar",
    "to be confirmed", "tbc", "tba", "to be announced", "not yet confirmed", "a definir", "nao confirmad",
  ],
};

export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when the quote contains wording that supports moving a festival to `status`. */
export function quoteSupportsStatus(quote: string, status: "cancelada" | "aplazada" | "tentativa"): boolean {
  const text = foldText(quote);
  // Stems are folded the same way: NFD splits Hangul syllables and drops Cyrillic breves.
  return STATUS_STEMS[status].some((stem) => text.includes(foldText(stem)));
}
