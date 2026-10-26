// Ties a proposed change to the search citations: which URLs were really cited, whether the quote
// is verbatim (R1), and what the quote's numbers say. Pure.
import { canonicalUrl, hostOf, isBlocked, isOfficial, registrableDomain, tierOf, type DomainPolicy, type SourceTier } from "./domains.ts";
import type { Citation } from "./research.ts";

export interface CitedSource {
  url: string;
  host: string;
  domain: string;
  tier: SourceTier;
  official: boolean;
  title: string | null;
}

export interface SourceCheck {
  /** https, cited by the research call, not blocked. */
  cited: CitedSource[];
  notHttps: string[];
  notCited: string[];
  blocked: string[];
}

/** Whitespace-insensitive, NFC form used for the verbatim comparison. */
export function normalizeQuote(s: string): string {
  return s.normalize("NFC").replace(/[\s ​]+/g, " ").trim();
}

export const MIN_QUOTE_LENGTH = 8;

export function citationsByUrl(citations: readonly Citation[]): Map<string, Citation[]> {
  const map = new Map<string, Citation[]>();
  for (const c of citations) {
    const key = canonicalUrl(c.url);
    if (!key) continue;
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return map;
}

export function checkSources(urls: readonly string[], citations: readonly Citation[], policy: DomainPolicy): SourceCheck {
  const byUrl = citationsByUrl(citations);
  const out: SourceCheck = { cited: [], notHttps: [], notCited: [], blocked: [] };
  const seen = new Set<string>();
  for (const url of urls) {
    const key = canonicalUrl(url);
    const host = hostOf(url);
    if (!key || !host) {
      out.notHttps.push(url);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (isBlocked(url, policy)) {
      out.blocked.push(url);
      continue;
    }
    const hits = byUrl.get(key);
    if (!hits) {
      out.notCited.push(url);
      continue;
    }
    out.cited.push({ url: hits[0]!.url, host, domain: registrableDomain(host), tier: tierOf(url, policy), official: isOfficial(url, policy), title: hits[0]!.title });
  }
  return out;
}

/** The cited texts of the given sources. */
export function citedTextsFor(sources: readonly CitedSource[], citations: readonly Citation[]): string[] {
  const byUrl = citationsByUrl(citations);
  return sources.flatMap((s) => (byUrl.get(canonicalUrl(s.url) ?? "") ?? []).map((c) => c.cited_text));
}

/** R1: the quote must appear verbatim (after whitespace normalization) in a cited text of its sources. */
export function quoteIsVerbatim(quote: string, citedTexts: readonly string[]): boolean {
  const q = normalizeQuote(quote);
  if (q.length < MIN_QUOTE_LENGTH) return false;
  return citedTexts.some((t) => normalizeQuote(t).includes(q));
}

/** R1/R2 for tier-1 dates: one tier-A source, or two tier-B sources on different registrable domains. */
export function meetsTier1SourceRule(sources: readonly CitedSource[]): boolean {
  if (sources.some((s) => s.tier === "A")) return true;
  return new Set(sources.filter((s) => s.tier === "B").map((s) => s.domain)).size >= 2;
}

const SCALE: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(millones|millon|million|millions|milhoes|milhao|mi)$/, 1_000_000],
  [/^(mil|thousand|k)$/, 1_000],
];

/** Figures stated in a quote: «más de 6 millones», «137.672 turistas», «250,000 visitors», «250 mil». */
export function quoteNumbers(quote: string): number[] {
  const folded = quote.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
  const out: number[] = [];
  for (const m of folded.matchAll(/(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*([a-z]+)?/g)) {
    const [raw = "", unit = ""] = [m[1], m[2]];
    const grouped = /^\d{1,3}([.,\s]\d{3})+$/.test(raw);
    const base = grouped ? Number(raw.replace(/[.,\s]/g, "")) : Number(raw.replace(",", "."));
    const scale = SCALE.find(([re]) => re.test(unit))?.[1] ?? 1;
    if (Number.isFinite(base)) out.push(Math.round(base * scale));
  }
  return out;
}

/** Four-digit years mentioned in a quote, used to date an attendance figure. */
export function quoteYears(quote: string): number[] {
  return [...quote.matchAll(/\b(19[5-9]\d|20\d{2})\b/g)].map((m) => Number(m[1]));
}

/** Attendance qualifier from the quote's own words; never guessed beyond them. */
export function quoteQualifier(quote: string): "more_than" | "about" | "exact" {
  const t = quote.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
  if (/\b(mas de|more than|over|mais de|superior a|supero|superou)\b/.test(t)) return "more_than";
  if (/\b(cerca de|unos|unas|alrededor de|aproximadamente|aprox|about|around|nearly|almost|approximately|cerca|quase)\b/.test(t)) return "about";
  return "exact";
}
