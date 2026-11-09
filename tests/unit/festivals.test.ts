import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { applyFilters, buildEntries, isPendingPostponement, isVisible, nextOccurrence, upcoming, occurrencesBetween, ctxFor } from "../../src/festivals.ts";
import { CountryFile } from "../../src/schema.ts";
import type { ScoringConfig } from "../../src/score.ts";

const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
// Frozen PRD acceptance data (the CO file as the PRD tables were written); live data moves on.
const co = CountryFile.parse(JSON.parse(readFileSync("tests/fixtures/prd/co.json", "utf8")));
const TODAY = "2026-10-26";
const entries = buildEntries(co, config, TODAY);
const countryScope = { kind: "country", code: "CO" } as const;

describe("ranking and visibility", () => {
  test("the country top 5 ranks by the low end of the score", () => {
    const top = entries.filter((e) => e.inTopN).map((e) => e.festival.slug);
    expect(top).toEqual(["carnaval-barranquilla", "negros-y-blancos", "carnaval-riosucio", "festival-tambores-palenque", "san-pacho"]);
  });

  test("Riosucio (tier 2) shows in the Colombia view because it is in the top 5", () => {
    const riosucio = entries.find((e) => e.festival.slug === "carnaval-riosucio");
    expect(riosucio?.score.tier).toBe(2);
    expect(riosucio && isVisible(riosucio, countryScope, false)).toBe(true);
    expect(riosucio && isVisible(riosucio, { kind: "world" }, false)).toBe(false);
    expect(riosucio && isVisible(riosucio, { kind: "world" }, true)).toBe(true);
  });

  test("the world view shows only tier 1 unless the tier-2 switch is on", () => {
    const world = entries.filter((e) => isVisible(e, { kind: "world" }, false)).map((e) => e.festival.slug);
    expect(world).toEqual(["carnaval-barranquilla", "negros-y-blancos"]);
  });
});

describe("upcoming", () => {
  test("with today = 2026-10-26 and country = CO the first upcoming festival is Cartagena", () => {
    const next = upcoming(entries.filter((e) => isVisible(e, countryScope, false)), TODAY, 3);
    expect(next.map((e) => e.festival.slug)).toEqual(["independencia-cartagena", "feria-de-cali", "carnaval-riosucio"]);
    expect(next[0]?.occurrence?.start).toBe("2026-11-10");
  });

  test("an ongoing festival still counts as upcoming", () => {
    const during = buildEntries(co, config, "2026-12-27");
    expect(upcoming(during, "2026-12-27", 1)[0]?.festival.slug).toBe("feria-de-cali");
  });

  test("occurrencesBetween returns every edition overlapping a window", () => {
    const f = co.festivals.find((x) => x.slug === "carnaval-barranquilla");
    if (!f) throw new Error("missing");
    const occ = occurrencesBetween(f, "2027-01-01", "2028-12-31", ctxFor(co));
    expect(occ.map((o) => o.start)).toEqual(["2027-02-06", "2028-02-26"]);
  });
});

describe("filters", () => {
  test("travel dates 2027-02-01 to 2027-02-10 in Colombia return Barranquilla (RF-04)", () => {
    const visible = entries.filter((e) => isVisible(e, countryScope, true));
    const hits = applyFilters(visible, { from: "2027-02-01", to: "2027-02-10" }, TODAY);
    expect(hits.map((h) => h.entry.festival.slug)).toEqual(["carnaval-barranquilla"]);
    expect(hits[0]?.occurrence.start).toBe("2027-02-06");
  });

  test("month and type filters combine", () => {
    const visible = entries.filter((e) => isVisible(e, countryScope, true));
    const jan = applyFilters(visible, { months: ["2027-01"] }, TODAY).map((h) => h.entry.festival.slug);
    expect(jan).toEqual(["carnaval-riosucio", "negros-y-blancos"]);
    const janCarnival = applyFilters(visible, { months: ["2027-01"], types: ["carnaval"] }, TODAY);
    expect(janCarnival).toHaveLength(2);
    expect(applyFilters(visible, { months: ["2027-01"], types: ["musica"] }, TODAY)).toHaveLength(0);
  });

  test("announced windows that overlap the travel dates come back marked as possible", () => {
    const visible = entries.filter((e) => isVisible(e, countryScope, true));
    const hits = applyFilters(visible, { from: "2027-08-05", to: "2027-08-07" }, TODAY);
    expect(hits.map((h) => [h.entry.festival.slug, h.possible])).toEqual([
      ["feria-de-las-flores", true],
      ["petronio-alvarez", true],
    ]);
  });
});

describe("garbled links never throw", () => {
  // BE-05: the router accepts any four-digit year; year 0000 is no civil date.
  test("a month in year 0000 matches nothing instead of throwing", () => {
    expect(applyFilters(entries, { months: ["0000-01"] }, TODAY)).toEqual([]);
  });
});

describe("pending postponement (UI-2)", () => {
  const live = CountryFile.parse(JSON.parse(readFileSync("tests/fixtures/site/countries/co.json", "utf8")));
  const petronio = live.festivals.find((f) => f.slug === "petronio-alvarez");

  test("the dateless postponed Petronio 2026 is a pending postponement after its old window", () => {
    if (!petronio) throw new Error("missing");
    const occ = nextOccurrence(petronio, TODAY, ctxFor(live));
    expect(occ).toMatchObject({ year: 2026, status: "aplazada" });
    expect(occ && isPendingPostponement(occ)).toBe(true);
  });
});
