import { describe, expect, test } from "vitest";
import {
  addDays,
  diffDays,
  easter,
  formatDayMonth,
  nthWeekday,
  occurrenceFor,
  parseISODate,
  resolveRule,
  todayIn,
  weekday,
} from "../../src/dates.ts";
import type { Festival, Rule } from "../../src/schema.ts";

const noRefs = { resolveRef: () => null };

const festival = (over: Partial<Festival>): Festival => ({
  slug: "x",
  names: { local: "X", es: "X", en: "X", pt: "X" },
  city: "C",
  subdivision: "CO-ATL",
  timezone: "America/Bogota",
  coords: { lat: 0, lon: 0 },
  type: "carnaval",
  rule: { type: "fixed", start: "01-01", end: "01-02" },
  editions: {},
  score: { convocatoria: null, fiesta: null, viajeros: null, calle: null, conectividad: null },
  ...over,
});

const barranquilla: Rule = { type: "easter_offset", calendar: "gregorian", start: -50, end: -47 };
const riosucio: Rule = { type: "nth_weekday", month: 1, weekday: 5, n: 1, duration_days: 6, parity: "odd" };

describe("civil date helpers", () => {
  test("parse and add days without touching the local time zone", () => {
    expect(parseISODate("2028-02-29")).toEqual({ y: 2028, m: 2, d: 29 });
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(diffDays("2026-10-26", "2026-11-10")).toBe(15);
  });

  test("weekday uses 0 = Sunday", () => {
    expect(weekday("2027-01-01")).toBe(5);
    expect(weekday("2026-10-26")).toBe(1);
  });

  test("rejects malformed dates", () => {
    expect(() => parseISODate("2027-02-30")).toThrow();
    expect(() => parseISODate("27-2-3")).toThrow();
  });
});

describe("Easter", () => {
  test("gregorian 2027 = 2027-03-28 and 2028 = 2028-04-16", () => {
    expect(easter(2027, "gregorian")).toBe("2027-03-28");
    expect(easter(2028, "gregorian")).toBe("2028-04-16");
  });

  test("orthodox 2027 = 2027-05-02 (Julian computus shown as Gregorian)", () => {
    expect(easter(2027, "orthodox")).toBe("2027-05-02");
    expect(easter(2026, "orthodox")).toBe("2026-04-12");
  });
});

describe("PRD mandatory rule cases", () => {
  test("Barranquilla 2027 = 2027-02-06 to 2027-02-09; 2028 = 2028-02-26 to 2028-02-29", () => {
    expect(resolveRule(barranquilla, 2027, noRefs)).toMatchObject({ start: "2027-02-06", end: "2027-02-09" });
    expect(resolveRule(barranquilla, 2028, noRefs)).toMatchObject({ start: "2028-02-26", end: "2028-02-29" });
  });

  test("Guacherna 2027 = 2027-01-29 (relative_to Barranquilla, -8 days)", () => {
    const ctx = { resolveRef: (slug: string, year: number) => (slug === "carnaval-barranquilla" ? resolveRule(barranquilla, year, noRefs) : null) };
    const guacherna: Rule = { type: "relative_to", ref: "carnaval-barranquilla", anchor: "start", offset: -8, duration_days: 1 };
    expect(resolveRule(guacherna, 2027, ctx)).toMatchObject({ start: "2027-01-29", end: "2027-01-29" });
  });

  test("Riosucio: 2023, 2025, 2027 from the first Friday of January; no edition in 2028", () => {
    expect(resolveRule(riosucio, 2023, noRefs)).toMatchObject({ start: "2023-01-06", end: "2023-01-11" });
    expect(resolveRule(riosucio, 2025, noRefs)).toMatchObject({ start: "2025-01-03", end: "2025-01-08" });
    expect(resolveRule(riosucio, 2027, noRefs)).toMatchObject({ start: "2027-01-01", end: "2027-01-06" });
    expect(resolveRule(riosucio, 2028, noRefs)).toBeNull();
  });

  test("Pasto 2027 = 2027-01-02 to 2027-01-07; Cali 2026 = 2026-12-25 to 2026-12-30", () => {
    expect(resolveRule({ type: "fixed", start: "01-02", end: "01-07" }, 2027, noRefs)).toMatchObject({ start: "2027-01-02", end: "2027-01-07" });
    expect(resolveRule({ type: "fixed", start: "12-25", end: "12-30" }, 2026, noRefs)).toMatchObject({ start: "2026-12-25", end: "2026-12-30" });
  });

  test("last Monday of August 2027 = 2027-08-30", () => {
    expect(nthWeekday(2027, 8, 1, -1)).toBe("2027-08-30");
    expect(resolveRule({ type: "nth_weekday", month: 8, weekday: 1, n: -1, duration_days: 1 }, 2027, noRefs)).toMatchObject({ start: "2027-08-30" });
  });

  test("lunisolar_table without a row for the year returns «por anunciar», never an estimate", () => {
    const holi: Rule = {
      type: "lunisolar_table",
      calendar: "hindu",
      sighting_dependent: false,
      table: { "2027": { start: "2027-03-22", end: "2027-03-22" } },
      table_source: "https://example.org/table",
    };
    expect(resolveRule(holi, 2027, noRefs)).toMatchObject({ start: "2027-03-22", kind: "table" });
    expect(resolveRule(holi, 2029, noRefs)).toBeNull();
    const occ = occurrenceFor(festival({ rule: holi }), 2029, noRefs);
    expect(occ?.status).toBe("por_anunciar");
    expect(occ?.start).toBeUndefined();
  });

  test("a sighting-dependent lunar date is flagged as estimated (RF-19)", () => {
    const eid: Rule = {
      type: "lunisolar_table",
      calendar: "islamic",
      sighting_dependent: true,
      table: { "2027": { start: "2027-03-10", end: "2027-03-12" } },
      table_source: "https://example.org/table",
    };
    const occ = occurrenceFor(festival({ rule: eid }), 2027, noRefs);
    expect(occ?.estimated).toBe(true);
    expect(occ?.confidence).toBe("estimacion");
  });

  test("a date stored for Asia/Tokyo shows the same day from America/Lima", () => {
    const parts = formatDayMonth("2027-04-13", "es-PE");
    expect(parts).toContain("13");
    const tokyo = todayIn("Asia/Tokyo", new Date(Date.UTC(2027, 3, 12, 20, 0)));
    const lima = todayIn("America/Lima", new Date(Date.UTC(2027, 3, 12, 20, 0)));
    expect(tokyo).toBe("2027-04-13");
    expect(lima).toBe("2027-04-12");
  });

  test("a confirmed date in the data replaces the one computed by the rule", () => {
    const f = festival({
      rule: barranquilla,
      editions: {
        "2027": {
          start: "2027-02-05",
          end: "2027-02-09",
          status: "confirmada",
          confidence: "oficial",
          key_events: [],
          sources: [{ url: "https://carnavaldebarranquilla.org/", publisher: "Carnaval S.A.S.", accessed: "2026-10-26" }],
          sequence: 0,
        },
      },
    });
    const occ = occurrenceFor(f, 2027, noRefs);
    expect(occ).toMatchObject({ start: "2027-02-05", end: "2027-02-09", status: "confirmada", origin: "edition" });
    expect(occurrenceFor(f, 2028, noRefs)).toMatchObject({ start: "2028-02-26", status: "tentativa", confidence: "patron", origin: "rule" });
  });
});

describe("other rule shapes", () => {
  test("fixed ranges that cross the new year end in the next year", () => {
    expect(resolveRule({ type: "fixed", start: "12-28", end: "01-06" }, 2026, noRefs)).toMatchObject({ start: "2026-12-28", end: "2027-01-06" });
  });

  test("announced rules give a window, not dates", () => {
    const occ = occurrenceFor(festival({ rule: { type: "announced", window: { start: "04-25", end: "05-05" } } }), 2027, noRefs);
    expect(occ?.status).toBe("por_anunciar");
    expect(occ?.window).toEqual({ start: "2027-04-25", end: "2027-05-05" });
    expect(occ?.start).toBeUndefined();
  });

  test("parity applies to every rule type", () => {
    expect(resolveRule({ type: "fixed", start: "06-01", end: "06-02", parity: "even" }, 2027, noRefs)).toBeNull();
    expect(resolveRule({ type: "easter_offset", calendar: "gregorian", start: 0, end: 0, parity: "even" }, 2028, noRefs)).toMatchObject({ start: "2028-04-16" });
  });

  test("relative_to with an unknown ref resolves to nothing", () => {
    expect(resolveRule({ type: "relative_to", ref: "nope", anchor: "end", offset: 1, duration_days: 2 }, 2027, noRefs)).toBeNull();
  });

  test("a tentative edition without dates keeps the rule dates, labeled as pattern", () => {
    const f = festival({
      rule: { type: "fixed", start: "11-10", end: "11-16" },
      editions: { "2026": { status: "tentativa", confidence: "prensa", key_events: [], sources: [{ url: "https://www.eluniversal.com.co/x", publisher: "El Universal", accessed: "2026-10-26" }], sequence: 0 } },
    });
    expect(occurrenceFor(f, 2026, noRefs)).toMatchObject({ start: "2026-11-10", end: "2026-11-16", status: "tentativa", confidence: "patron", origin: "edition" });
  });

  test("an edition with status but no dates keeps the rule window and the edition status", () => {
    const f = festival({
      rule: { type: "announced", window: { start: "08-01", end: "08-31" } },
      editions: { "2027": { status: "aplazada", confidence: "prensa", key_events: [], sources: [{ url: "https://radionacional.co/x", publisher: "Radio Nacional", accessed: "2026-10-26" }], sequence: 1 } },
    });
    expect(occurrenceFor(f, 2027, noRefs)).toMatchObject({ status: "aplazada", window: { start: "2027-08-01", end: "2027-08-31" } });
  });
});

describe("schema guards", () => {
  test("a confirmed edition needs its dates and a source", async () => {
    const { Edition } = await import("../../src/schema.ts");
    const src = [{ url: "https://a.org/x", publisher: "A", accessed: "2026-10-26" }];
    expect(Edition.safeParse({ status: "confirmada", confidence: "oficial", sources: src }).success).toBe(false);
    expect(Edition.safeParse({ status: "confirmada", confidence: "oficial", start: "2027-01-02", end: "2027-01-07", sources: [] }).success).toBe(false);
    expect(Edition.safeParse({ status: "confirmada", confidence: "oficial", start: "2027-01-02", end: "2027-01-07", sources: src }).success).toBe(true);
  });
});
