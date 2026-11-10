import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { classify, scoreFestival, type ScoringConfig } from "../../src/score.ts";
import { CountryFile, type ScoreInputs } from "../../src/schema.ts";

const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
// Frozen PRD acceptance data (the CO file as the PRD tables were written); live data moves on.
const co = CountryFile.parse(JSON.parse(readFileSync("tests/fixtures/prd/co.json", "utf8")));
const bySlug = (slug: string) => {
  const f = co.festivals.find((x) => x.slug === slug);
  if (!f) throw new Error(slug);
  return scoreFestival(f.score, config);
};

describe("scoring", () => {
  test("attendance scale uses inclusive lower bounds", () => {
    const at = (attendance: number): ScoreInputs => ({
      convocatoria: { measure: { attendance, qualifier: "exact", unit: "attendees", year: 2026 }, confidence: "oficial" },
      fiesta: null, viajeros: null, calle: null, conectividad: null,
    });
    expect(scoreFestival(at(1_000_000), config).criteria[0]?.points).toBe(30);
    expect(scoreFestival(at(250_000), config).criteria[0]?.points).toBe(22);
    expect(scoreFestival(at(249_999), config).criteria[0]?.points).toBe(15);
    expect(scoreFestival(at(25_000), config).criteria[0]?.points).toBe(8);
    expect(scoreFestival(at(10), config).criteria[0]?.points).toBe(3);
  });

  test("an unmeasured criterion is 0 at the low end and its max at the high end", () => {
    const empty: ScoreInputs = { convocatoria: null, fiesta: null, viajeros: null, calle: null, conectividad: null };
    expect(scoreFestival(empty, config)).toMatchObject({ low: 0, high: 100, measured: false, tier: "provisional", excluded: false });
  });

  test("the weights add up to 100, and party and travelers weigh half of it (2026-11-09)", () => {
    const c = config.criteria;
    expect(c.convocatoria.max + c.fiesta.max + c.viajeros.max + c.calle.max + c.conectividad.max).toBe(100);
    expect(c.fiesta.max + c.viajeros.max).toBe(50);
    expect(Math.max(...Object.values(c.fiesta.levels))).toBe(c.fiesta.max);
    expect(Math.max(...Object.values(c.viajeros.levels))).toBe(c.viajeros.max);
    // A solemn act scores nothing: it is excluded, not ranked (src/score.ts isParty).
    expect(c.fiesta.levels.solemne).toBeUndefined();
  });

  test("dancing in the street outranks the same crowd watching a show", () => {
    const at = (fiesta: "baile_abierto" | "show"): ScoreInputs => ({
      convocatoria: { measure: { attendance: 300_000, qualifier: "exact", unit: "visitors", year: 2026 }, confidence: "oficial", source: "https://a.gov.co/x" },
      fiesta: { measure: fiesta, confidence: "estimacion" },
      viajeros: { measure: "nacional", confidence: "estimacion" },
      calle: { measure: "mayoria_gratis", confidence: "estimacion" },
      conectividad: { measure: "nacional", confidence: "estimacion" },
    });
    expect(scoreFestival(at("baile_abierto"), config)).toMatchObject({ low: 80, tier: 1 });
    expect(scoreFestival(at("show"), config)).toMatchObject({ low: 56, tier: 2 });
  });

  test("classification thresholds", () => {
    const t = config.thresholds;
    expect(classify(93, 93, t)).toBe(1);
    expect(classify(65, 90, t)).toBe(1);
    expect(classify(59, 59, t)).toBe(2);
    expect(classify(45, 65, t)).toBe("provisional");
    expect(classify(30, 44, t)).toBe("hidden");
    expect(classify(46, 60, t)).toBe(2);
  });

  // Party and travelers scoring (2026-11-09), with the classifier's first run on the PRD-era figures.
  test("reproduces the PRD Colombia pilot table", () => {
    const table: Array<[string, number, number, 1 | 2 | "provisional"]> = [
      ["carnaval-barranquilla", 100, 100, 1],
      ["negros-y-blancos", 88, 88, 1],
      ["feria-de-cali", 64, 64, 2],
      ["festival-vallenato", 69, 69, 1],
      ["san-pacho", 66, 96, 1],
      ["festival-tambores-palenque", 30, 60, "provisional"],
      ["carnaval-riosucio", 50, 50, 2],
      ["independencia-cartagena", 46, 76, "provisional"],
      ["feria-de-las-flores", 36, 76, "provisional"],
      ["petronio-alvarez", 52, 92, "provisional"],
    ];
    for (const [slug, low, high, tier] of table) {
      expect(bySlug(slug), slug).toMatchObject({ low, high, tier });
    }
  });
});
