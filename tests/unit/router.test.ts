// RF-03 / RF-12: every view has a shareable hash URL; filters live in the query and round-trip.
import { describe, expect, test } from "vitest";
import { EMPTY_FILTERS, hasActiveFilters, parseFilters, parseHash, serializeFilters, serializeRoute, todayOverride, type Route } from "../../src/router.ts";

const roundTrip = (route: Route): Route => parseHash(serializeRoute(route));

describe("parseHash / serializeRoute round-trip", () => {
  const routes: Route[] = [
    { name: "home", query: { tier2: false } },
    { name: "home", query: { tier2: true } },
    { name: "country", code: "CO", query: { tier2: false } },
    { name: "country", code: "PE", query: { tier2: true } },
    { name: "region", region: "sudamerica", query: { tier2: false } },
    { name: "festival", slug: "carnaval-barranquilla" },
    { name: "saved" },
    { name: "settings" },
    { name: "about" },
    { name: "explore", filters: { ...EMPTY_FILTERS } },
    {
      name: "explore",
      filters: { countries: ["CO", "PE"], months: ["2027-01", "2027-02"], types: ["carnaval", "musica"], tier2: true, from: "2027-02-01", to: "2027-02-10", sort: "near" },
    },
  ];

  test.each(routes.map((r) => [serializeRoute(r), r] as const))("%s", (_hash, route) => {
    expect(roundTrip(route)).toEqual(route);
  });

  test("uses the documented paths", () => {
    expect(serializeRoute({ name: "country", code: "CO", query: { tier2: false } })).toBe("#/pais/co");
    expect(serializeRoute({ name: "festival", slug: "feria-de-cali" })).toBe("#/fiesta/feria-de-cali");
    expect(serializeRoute({ name: "about" })).toBe("#/datos");
    expect(serializeRoute({ name: "explore", filters: { ...EMPTY_FILTERS, countries: ["CO"], from: "2027-02-01", to: "2027-02-10" } })).toBe(
      "#/explorar?pais=co&desde=2027-02-01&hasta=2027-02-10",
    );
  });
});

describe("parseHash", () => {
  test("an empty or bare hash is Inicio", () => {
    expect(parseHash("")).toEqual({ name: "home", query: { tier2: false } });
    expect(parseHash("#/")).toEqual({ name: "home", query: { tier2: false } });
    expect(parseHash("#/?nivel=2")).toEqual({ name: "home", query: { tier2: true } });
  });

  test("tolerates trailing slashes and upper-case country codes", () => {
    expect(parseHash("#/pais/CO/")).toEqual({ name: "country", code: "CO", query: { tier2: false } });
    expect(parseHash("#/explorar/")).toEqual({ name: "explore", filters: EMPTY_FILTERS });
  });

  test("unknown paths, bad slugs and unknown regions are notfound", () => {
    expect(parseHash("#/nada").name).toBe("notfound");
    expect(parseHash("#/fiesta/Not_A_Slug").name).toBe("notfound");
    expect(parseHash("#/fiesta/%3Cscript%3E").name).toBe("notfound");
    expect(parseHash("#/region/atlantida").name).toBe("notfound");
    expect(parseHash("#/pais/colombia").name).toBe("notfound");
    expect(parseHash("#/fiesta/%E0%A4%A").name).toBe("notfound");
  });

  test("notfound keeps its path so it can be shown and re-serialized", () => {
    const route = parseHash("#/nada/mas");
    expect(route).toEqual({ name: "notfound", path: "/nada/mas" });
    expect(serializeRoute(route)).toBe("#/nada/mas");
  });
});

describe("parseFilters", () => {
  test("canonicalizes order, case and duplicates", () => {
    const f = parseFilters(new URLSearchParams("pais=pe,co,co&mes=2027-02,2027-01&tipo=musica,carnaval"));
    expect(f.countries).toEqual(["CO", "PE"]);
    expect(f.months).toEqual(["2027-01", "2027-02"]);
    expect(f.types).toEqual(["carnaval", "musica"]);
    expect(serializeFilters(f)).toBe("pais=co,pe&mes=2027-01,2027-02&tipo=carnaval,musica");
  });

  test("drops invalid values instead of failing", () => {
    const f = parseFilters(new URLSearchParams("pais=col,1x&mes=2027-13,2027-1&tipo=rave&desde=2027-02-30&hasta=mañana&nivel=3&orden=lejos"));
    expect(f).toEqual(EMPTY_FILTERS);
  });

  test("swaps a reversed travel range", () => {
    const f = parseFilters(new URLSearchParams("desde=2027-02-10&hasta=2027-02-01"));
    expect([f.from, f.to]).toEqual(["2027-02-01", "2027-02-10"]);
  });

  test("keeps an open-ended range", () => {
    expect(parseFilters(new URLSearchParams("desde=2027-02-01"))).toEqual({ ...EMPTY_FILTERS, from: "2027-02-01" });
  });
});

describe("hasActiveFilters", () => {
  test("is false with no filters, whatever the sort order", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, sort: "near" })).toBe(false);
  });

  test("is true with any filter", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, tier2: true })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, to: "2027-01-01" })).toBe(true);
  });
});

describe("todayOverride (test hook)", () => {
  test("reads a valid ?today= date", () => {
    expect(todayOverride("?today=2026-10-26")).toBe("2026-10-26");
  });

  test("ignores missing or invalid values", () => {
    expect(todayOverride("")).toBeNull();
    expect(todayOverride("?today=2026-02-30")).toBeNull();
    expect(todayOverride("?today=hoy")).toBeNull();
  });
});
