// Country facts the pipeline needs before any data file exists, and per-language vocabulary
// for the news sweep (R9) and for status checks on quotes.
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

/** [assumption: capital-city zone as the country default; festivals keep their own zone] */
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

export function countryInfo(code: string): CountryInfo | null {
  return COUNTRIES[code.toUpperCase()] ?? null;
}

/** Language for prompts and quote checks: the country's own, falling back to Spanish. */
export function langFor(code: string): Lang {
  return countryInfo(code)?.lang ?? "es";
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

/** R9 cadence: the sweep runs for festivals 45 days out or less (daily in the last week, see H6). */
export const NEWS_SWEEP_DAYS = 45;

export function needsNewsSweep(daysToStart: number): boolean {
  return daysToStart <= NEWS_SWEEP_DAYS;
}

/** Search terms for the sweep: local language first, then English and Portuguese, no duplicates. */
export function newsTerms(lang: Lang): string[] {
  return [...new Set([...NEWS_TERMS[lang], ...NEWS_TERMS.en, ...NEWS_TERMS.pt])];
}

/** Stems (accent-free, lowercase) that make a quote say a festival was cancelled or postponed. */
const STATUS_STEMS: Readonly<Record<"cancelada" | "aplazada" | "tentativa", readonly string[]>> = {
  cancelada: ["cancelad", "suspendid", "cancel", "suspend", "suspens", "no se realizara", "will not take place", "nao sera realizad"],
  aplazada: ["aplazad", "pospuest", "postergad", "reprogramad", "postpon", "reschedul", "adiad", "remarcad"],
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
  return STATUS_STEMS[status].some((stem) => text.includes(stem));
}
