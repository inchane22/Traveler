// Hand-built countries and changes for the ops suites, so they do not depend on data/countries
// files that other changes may be editing.
import { CountryFile, Festival, type Edition, type Source } from "../../../src/schema.ts";
import type { CitedSource } from "../../../scripts/lib/evidence.ts";
import type { ReviewedChange } from "../../../scripts/lib/validate.ts";

export function fest(cc: string, slug: string, rule: unknown, editions: Record<string, unknown> = {}): Festival {
  return Festival.parse({
    slug,
    names: { local: slug, es: slug, en: slug, pt: slug },
    city: "Test",
    subdivision: `${cc}-01`,
    timezone: "America/Bogota",
    coords: { lat: 0, lon: 0 },
    type: "carnaval",
    rule,
    editions,
    score: { convocatoria: null, calle: null, reconocimiento: null, conectividad: null, local: null },
  });
}

export function nation(cc: string, festivals: readonly Festival[]): CountryFile {
  return CountryFile.parse({ country: cc, status: "publicado", generated_at: "2026-10-01", timezone: "America/Bogota", region: "sudamerica", festivals });
}

export function source(url: string, over: Partial<Source> = {}): Source {
  return { url, publisher: new URL(url).hostname, accessed: "2026-09-01", ...over };
}

export function edition(over: Partial<Edition> = {}): Edition {
  return { status: "tentativa", confidence: "prensa", key_events: [], sources: [], sequence: 0, ...over };
}

export function cited(url: string): CitedSource {
  const host = new URL(url).hostname;
  return { url, host, domain: host, tier: "B", official: false, title: null };
}

/** An accepted change as validate.ts would hand it to apply.ts. */
export function accepted(over: Partial<ReviewedChange> = {}): ReviewedChange {
  return {
    country: "AA",
    slug: "fest",
    name: "Fest",
    tier: 2,
    year: 2027,
    daysToStart: 90,
    field: "start",
    old: null,
    new: "2027-03-02",
    kind: "change",
    sources: [cited("https://example.org/fest")],
    quote_url: "https://example.org/fest",
    quote: "del 2 de marzo de 2027",
    quote_language: "es",
    proposed_confidence: "prensa",
    confidence: "prensa",
    note: "",
    verdict: "accepted",
    flags: [],
    reasons: [],
    adjustments: [],
    risk: 50,
    ...over,
  } as ReviewedChange;
}
