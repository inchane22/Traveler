import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { findLeaks } from "../../scripts/check-secrets.ts";
import { buildIndex, loadCountries } from "../../scripts/build-data.ts";
import type { ScoringConfig } from "../../src/score.ts";

const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;

describe("check-secrets (R8)", () => {
  const prefix = ["sk", "ant", ""].join("-");
  test("flags a key-shaped token, ignores the bare prefix in docs", () => {
    const files: Record<string, string> = {
      "leak.js": `const k = "${prefix}api03-${"a".repeat(40)}"`,
      "PRD.md": `el build falla si encuentra el prefijo \`${prefix}\``,
    };
    expect(findLeaks(Object.keys(files), (p) => files[p] ?? "")).toEqual(["leak.js"]);
  });
});

describe("build-data", () => {
  const countries = loadCountries("data/countries");
  test("every country file validates and the index lists tier-1 festivals", () => {
    const index = buildIndex(countries, config, false);
    expect(index.countries.every((c) => c.status === "publicado")).toBe(true);
    expect(index.tier1).toContain("CO/carnaval-barranquilla");
    expect(index.slugs["independencia-cartagena"]).toBe("CO");
  });

  test("drafts never appear in the production index", () => {
    const draft = { ...countries[0]!, country: "ZZ", status: "borrador" as const, festivals: [] };
    expect(buildIndex([...countries, draft], config, false).countries.map((c) => c.code)).not.toContain("ZZ");
    expect(buildIndex([...countries, draft], config, true).countries.map((c) => c.code)).toContain("ZZ");
  });

  test("the committed data/index.json is up to date", () => {
    const committed = JSON.parse(readFileSync("data/index.json", "utf8"));
    expect(committed).toEqual(buildIndex(countries, config, false));
  });
});
