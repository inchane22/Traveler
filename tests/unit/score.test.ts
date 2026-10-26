import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { classify, scoreFestival, type ScoringConfig } from "../../src/score.ts";
import { CountryFile, type ScoreInputs } from "../../src/schema.ts";

const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
const co = CountryFile.parse(JSON.parse(readFileSync("data/countries/co.json", "utf8")));
const bySlug = (slug: string) => {
  const f = co.festivals.find((x) => x.slug === slug);
  if (!f) throw new Error(slug);
  return scoreFestival(f.score, config);
};

describe("scoring", () => {
  test("attendance scale uses inclusive lower bounds", () => {
    const at = (attendance: number): ScoreInputs => ({
      convocatoria: { measure: { attendance, qualifier: "exact", unit: "attendees", year: 2026 }, confidence: "oficial" },
      calle: null, reconocimiento: null, conectividad: null, local: null,
    });
    expect(scoreFestival(at(1_000_000), config).criteria[0]?.points).toBe(35);
    expect(scoreFestival(at(250_000), config).criteria[0]?.points).toBe(26);
    expect(scoreFestival(at(249_999), config).criteria[0]?.points).toBe(18);
    expect(scoreFestival(at(25_000), config).criteria[0]?.points).toBe(10);
    expect(scoreFestival(at(10), config).criteria[0]?.points).toBe(4);
  });

  test("an unmeasured criterion is 0 at the low end and its max at the high end", () => {
    const empty: ScoreInputs = { convocatoria: null, calle: null, reconocimiento: null, conectividad: null, local: null };
    expect(scoreFestival(empty, config)).toMatchObject({ low: 0, high: 100, measured: false, tier: "provisional" });
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

  test("reproduces the PRD Colombia pilot table", () => {
    const table: Array<[string, number, number, 1 | 2 | "provisional"]> = [
      ["carnaval-barranquilla", 93, 93, 1],
      ["negros-y-blancos", 83, 83, 1],
      ["feria-de-cali", 54, 74, "provisional"],
      ["festival-vallenato", 45, 65, "provisional"],
      ["san-pacho", 57, 92, "provisional"],
      ["festival-tambores-palenque", 57, 92, "provisional"],
      ["carnaval-riosucio", 59, 59, 2],
      ["independencia-cartagena", 28, 83, "provisional"],
      ["feria-de-las-flores", 13, 93, "provisional"],
      ["petronio-alvarez", 13, 93, "provisional"],
    ];
    for (const [slug, low, high, tier] of table) {
      expect(bySlug(slug), slug).toMatchObject({ low, high, tier });
    }
  });
});
