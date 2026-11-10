// public/data/world.json (2026-11-10): the first screen reads one small file instead of the full
// file of every country with a tier-1 festival (7 of them, 177 KB, once Latin America went live).
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildIndex, loadCountries, worldBundle } from "../../scripts/build-data.ts";
import { buildEntries, isVisible } from "../../src/festivals.ts";
import type { CountryFile } from "../../src/schema.ts";
import { config, REPO, SITE_DATA } from "../fixtures/pipeline/helpers.ts";
import { fest, nation } from "../fixtures/pipeline/synthetic.ts";

const TIER1_SCORE = {
  convocatoria: { measure: { attendance: 2000000, qualifier: "more_than", unit: "attendees", year: 2026 }, confidence: "estimacion" },
  fiesta: { measure: "baile_abierto", confidence: "estimacion" },
  viajeros: { measure: "internacional", confidence: "estimacion" },
  calle: null,
  conectividad: null,
} as const;

describe("world.json", () => {
  test("keeps only tier-1 festivals and what their dates hang on, of countries that have one", () => {
    const big = { ...fest("AA", "big", { type: "relative_to", ref: "anchor", anchor: "start", offset: -3, duration_days: 2 }), score: TIER1_SCORE } as CountryFile["festivals"][number];
    const withEvent = {
      ...fest("AA", "big-two", { type: "fixed", start: "03-01", end: "03-03" }, {
        "2027": { start: "2027-03-01", end: "2027-03-03", status: "tentativa", confidence: "prensa", key_events: [{ id: "eve", name: { es: "Víspera" }, rule: { type: "relative_to", ref: "eve-ref", anchor: "start", offset: -1, duration_days: 1 }, confidence: "patron" }], sources: [], sequence: 0 },
      }),
      score: TIER1_SCORE,
    } as CountryFile["festivals"][number];
    const aa = nation("AA", [fest("AA", "small", { type: "fixed", start: "05-01", end: "05-02" }), big, fest("AA", "anchor", { type: "fixed", start: "02-10", end: "02-12" }), withEvent, fest("AA", "eve-ref", { type: "fixed", start: "02-27", end: "02-27" })]);
    const bb = nation("BB", [fest("BB", "only-small", { type: "fixed", start: "06-01", end: "06-02" })]);
    const index = buildIndex([aa, bb], config, false);
    expect(index.tier1).toEqual(["AA/big", "AA/big-two"]);
    const bundle = worldBundle(index, [aa, bb]);
    expect(bundle.countries.map((c) => c.country)).toEqual(["AA"]);
    // File order kept; «small» is gone, the two festivals the dates depend on stay.
    expect(bundle.countries[0]!.festivals.map((f) => f.slug)).toEqual(["big", "anchor", "big-two", "eve-ref"]);
  });

  test("on real data, the world view gets the same tier-1 entries from world.json as from the full files", () => {
    for (const dir of [join(REPO, "data", "countries"), join(SITE_DATA, "countries")]) {
      const countries = loadCountries(dir).filter((c) => c.status === "publicado");
      const index = buildIndex(countries, config, false);
      const bundle = worldBundle(index, countries);
      const world = { kind: "world" } as const;
      const today = "2026-11-10";
      const strip = (e: ReturnType<typeof buildEntries>[number]) => ({ country: e.country, slug: e.festival.slug, occurrence: e.occurrence, rank: e.rank, tier: e.score.tier });
      const full = countries.flatMap((c) => buildEntries(c, config, today)).filter((e) => isVisible(e, world, false)).map(strip);
      const slim = bundle.countries.flatMap((c) => buildEntries(c, config, today)).filter((e) => isVisible(e, world, false)).map(strip);
      expect(slim).toEqual(full);
      expect(slim.length).toBe(index.tier1.length);
      // One file, smaller than the ones it replaces (2026-11-10, data/: 7 files and 175 KB → 81 KB).
      const fullBytes = JSON.stringify(countries.filter((c) => bundle.countries.some((b) => b.country === c.country))).length;
      expect(JSON.stringify(bundle).length).toBeLessThan(fullBytes);
    }
  });
});
