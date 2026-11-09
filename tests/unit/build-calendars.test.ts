import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_KEYS,
  buildAllCalendars,
  buildCountryCalendars,
  calendarWindow,
  countryEvents,
  loadMessages,
  lookup,
  makeTranslator,
  missingKeys,
  parseToday,
  writeCalendars,
  type Messages,
} from "../../scripts/build-calendars.ts";
import { loadCountries } from "../../scripts/build-data.ts";
import { CountryFile, type CountryFile as Country, type Lang } from "../../src/schema.ts";
import type { ScoringConfig } from "../../src/score.ts";

// Test-only strings. The script itself reads locales/<lang>.json and fails on a missing key.
// es is nested and en/pt are flat, so both locale shapes are covered.
const ES: Messages = {
  ics: {
    prefix: { tentative: "[Por confirmar]", cancelled: "[Cancelada]", postponed: "[Aplazada]" },
    description: "Estado: {status}. Confianza: {confidence}. Ficha: {url}",
    calendarName: "Fiestas de {country}",
  },
  status: { confirmada: "Confirmada", tentativa: "Tentativa", por_anunciar: "Por anunciar", aplazada: "Aplazada", cancelada: "Cancelada" },
  confidence: { oficial: "Oficial", prensa: "Prensa", patron: "Patrón", estimacion: "Estimación" },
};
const EN: Messages = {
  "ics.prefix.tentative": "[To be confirmed]",
  "ics.prefix.cancelled": "[Cancelled]",
  "ics.prefix.postponed": "[Postponed]",
  "ics.description": "Status: {status}. Confidence: {confidence}. Details: {url}",
  "ics.calendarName": "Festivals in {country}",
  "status.confirmada": "Confirmed",
  "status.tentativa": "Tentative",
  "status.por_anunciar": "To be announced",
  "status.aplazada": "Postponed",
  "status.cancelada": "Cancelled",
  "confidence.oficial": "Official",
  "confidence.prensa": "Press",
  "confidence.patron": "Pattern",
  "confidence.estimacion": "Estimate",
};
const PT: Messages = {
  "ics.prefix.tentative": "[A confirmar]",
  "ics.prefix.cancelled": "[Cancelada]",
  "ics.prefix.postponed": "[Adiada]",
  "ics.description": "Status: {status}. Confiança: {confidence}. Ficha: {url}",
  "ics.calendarName": "Festas em {country}",
  "status.confirmada": "Confirmada",
  "status.tentativa": "Provisória",
  "status.por_anunciar": "A anunciar",
  "status.aplazada": "Adiada",
  "status.cancelada": "Cancelada",
  "confidence.oficial": "Oficial",
  "confidence.prensa": "Imprensa",
  "confidence.patron": "Padrão",
  "confidence.estimacion": "Estimativa",
};
const MESSAGES: Record<Lang, Messages> = { es: ES, en: EN, pt: PT };
const PREFIXES: Record<Lang, RegExp> = {
  es: /^\[(Por confirmar|Aplazada)\] /,
  en: /^\[(To be confirmed|Postponed)\] /,
  pt: /^\[(A confirmar|Adiada)\] /,
};

const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
const rawCo = JSON.parse(readFileSync("data/countries/co.json", "utf8")) as unknown;
const co = CountryFile.parse(rawCo);
const TODAY = "2026-10-26";
const SITE = "https://inchane22.github.io/traveler/";
const unfold = (ics: string): string => ics.replace(/\r\n[ \t]/g, "");

function withEdition(slug: string, year: string, edition: Record<string, unknown>): Country {
  const copy = structuredClone(rawCo) as { festivals: Array<{ slug: string; editions: Record<string, unknown> }> };
  const festival = copy.festivals.find((f) => f.slug === slug);
  if (!festival) throw new Error(`missing festival ${slug}`);
  festival.editions[year] = edition;
  return CountryFile.parse(copy);
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "traveler-cal-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("locale strings", () => {
  test("lookup reads flat and nested locale files", () => {
    expect(lookup(ES, "ics.prefix.tentative")).toBe("[Por confirmar]");
    expect(lookup(EN, "ics.prefix.tentative")).toBe("[To be confirmed]");
    expect(lookup(ES, "ics.prefix")).toBeUndefined();
    expect(lookup(ES, "ics.prefix.nope")).toBeUndefined();
    expect(lookup({ a: 1 }, "a")).toBeUndefined();
  });

  test("missingKeys lists every calendar key a locale lacks", () => {
    expect(missingKeys(ES)).toEqual([]);
    expect(missingKeys({})).toEqual([...REQUIRED_KEYS]);
    expect(missingKeys({ ...EN, "ics.prefix.tentative": "  " })).toEqual(["ics.prefix.tentative"]);
    expect(REQUIRED_KEYS).toContain("status.cancelada");
    expect(REQUIRED_KEYS).toContain("confidence.estimacion");
  });

  test("makeTranslator fills {placeholders} and refuses a missing key", () => {
    const t = makeTranslator(ES, "es");
    expect(t("ics.calendarName", { country: "Colombia" })).toBe("Fiestas de Colombia");
    expect(t("ics.description", { status: "Confirmada" })).toBe("Estado: Confirmada. Confianza: {confidence}. Ficha: {url}");
    expect(() => t("ics.nope")).toThrow(/locales\/es\.json.*ics\.nope/);
  });

  test("loadMessages reads locales/<lang>.json and names a missing file", () => {
    const dir = tmp();
    for (const lang of ["es", "en", "pt"] as const) writeFileSync(join(dir, `${lang}.json`), JSON.stringify(MESSAGES[lang]));
    expect(loadMessages(dir)).toEqual(MESSAGES);
    rmSync(join(dir, "pt.json"));
    expect(() => loadMessages(dir)).toThrow(/pt\.json/);
  });
});

describe("feed window", () => {
  test("runs from two months back to twelve months ahead", () => {
    expect(calendarWindow(TODAY)).toEqual({ from: "2026-08-26", to: "2027-10-26" });
  });

  test("parseToday accepts --today=YYYY-MM-DD and rejects anything else", () => {
    expect(parseToday(["--today=2026-10-26"])).toBe("2026-10-26");
    expect(parseToday(["--other"])).toBeUndefined();
    expect(() => parseToday(["--today=2026-02-30"])).toThrow(/--today/);
  });
});

describe("countryEvents", () => {
  const events = countryEvents(co, config, "es", makeTranslator(ES, "es"), TODAY, SITE);

  test("Colombia's feed holds every dated edition of a visible festival in the window", () => {
    expect(events.map((e) => e.uid).sort()).toEqual(
      [
        "carnaval-barranquilla-2027@traveler",
        "carnaval-riosucio-2027@traveler",
        "feria-de-cali-2026@traveler",
        "festival-tambores-palenque-2026@traveler",
        "festival-vallenato-2027@traveler",
        "independencia-cartagena-2026@traveler",
        "negros-y-blancos-2027@traveler",
        "san-pacho-2026@traveler",
        "san-pacho-2027@traveler",
      ].sort(),
    );
  });

  test("window-only festivals (por anunciar) are skipped", () => {
    expect(events.some((e) => e.uid.startsWith("feria-de-las-flores"))).toBe(false);
    expect(events.some((e) => e.uid.startsWith("petronio-alvarez"))).toBe(false);
  });

  test("a cancellation from the past two months still reaches subscribers (RF-18)", () => {
    const cancelled = withEdition("petronio-alvarez", "2026", {
      start: "2026-08-12",
      end: "2026-08-17",
      status: "cancelada",
      confidence: "oficial",
      sources: [{ url: "https://www.cali.gov.co/", publisher: "Alcaldía de Cali", accessed: "2026-08-11", tier: "A" }],
      sequence: 1,
    });
    const t = makeTranslator(ES, "es");
    const soon = countryEvents(cancelled, config, "es", t, "2026-09-15", SITE).find((e) => e.uid === "petronio-alvarez-2026@traveler");
    expect(soon).toMatchObject({ status: "CANCELLED", sequence: 1 });
    expect(soon?.summary).toMatch(/^\[Cancelada\] /);
    expect(countryEvents(cancelled, config, "es", t, TODAY, SITE).some((e) => e.uid === "petronio-alvarez-2026@traveler")).toBe(false);
  });

  // R9: the news sweep stores a cancellation or a postponement without dates. Subscribers hold the
  // rule's event at SEQUENCE 0; apply starts the edition at 1 so that event updates, not vanishes.
  test("an undated cancellation keeps the rule's event, now CANCELLED with the new SEQUENCE (R9, RF-18)", () => {
    const t = makeTranslator(ES, "es");
    const uid = "negros-y-blancos-2027@traveler";
    const before = countryEvents(co, config, "es", t, TODAY, SITE).find((e) => e.uid === uid);
    expect(before).toMatchObject({ status: "TENTATIVE", sequence: 0 });
    const source = { url: "https://www.pasto.gov.co/", publisher: "Alcaldía de Pasto", accessed: TODAY, tier: "A" };
    const cancelled = withEdition("negros-y-blancos", "2027", { status: "cancelada", confidence: "oficial", sources: [source], sequence: 1 });
    const after = countryEvents(cancelled, config, "es", t, TODAY, SITE).find((e) => e.uid === uid);
    expect(after).toMatchObject({ status: "CANCELLED", sequence: 1, start: before!.start, end: before!.end });
    expect(after?.summary).toMatch(/^\[Cancelada\] /);

    const postponed = withEdition("negros-y-blancos", "2027", { status: "aplazada", confidence: "oficial", sources: [source], sequence: 1 });
    expect(countryEvents(postponed, config, "es", t, TODAY, SITE).find((e) => e.uid === uid)).toMatchObject({ status: "TENTATIVE", sequence: 1, summary: expect.stringMatching(/^\[Aplazada\] /) });
  });

  test("an undated edition that is only not announced yet still has no event", () => {
    const t = makeTranslator(ES, "es");
    const unknown = withEdition("negros-y-blancos", "2027", { status: "por_anunciar", confidence: "patron", sequence: 1 });
    expect(countryEvents(unknown, config, "es", t, TODAY, SITE).some((e) => e.uid === "negros-y-blancos-2027@traveler")).toBe(false);
  });
});

describe("buildCountryCalendars", () => {
  const files = buildCountryCalendars(co, config, MESSAGES, TODAY, SITE);

  test("writes Spanish, English and Portuguese feeds for the country", () => {
    expect(files.map((f) => f.path)).toEqual(["calendars/co.ics", "calendars/co.en.ics", "calendars/co.pt.ics"]);
    expect(files.map((f) => f.events)).toEqual([9, 9, 9]);
  });

  test("names each feed in its language and stamps it with generated_at", () => {
    const [es = "", en = "", pt = ""] = files.map((f) => unfold(f.content));
    expect(es).toContain("\r\nX-WR-CALNAME:Fiestas de Colombia\r\n");
    expect(en).toContain("\r\nX-WR-CALNAME:Festivals in Colombia\r\n");
    expect(pt).toContain("\r\nX-WR-CALNAME:Festas em Colômbia\r\n");
    expect(en).toContain("\r\nSUMMARY:Barranquilla Carnival\r\n");
    for (const ics of [es, en, pt]) {
      expect(ics.match(/\r\nDTSTAMP:(\S+)\r\n/g)?.every((l) => l === "\r\nDTSTAMP:20261026T000000Z\r\n")).toBe(true);
    }
  });

  test("every TENTATIVE event carries the localized mark, in every language", () => {
    for (const [i, lang] of (["es", "en", "pt"] as const).entries()) {
      const ics = unfold(files[i]?.content ?? "");
      const blocks = ics.split("BEGIN:VEVENT").slice(1);
      expect(blocks.length).toBe(9);
      for (const block of blocks) {
        const summary = /\r\nSUMMARY:(.*)\r\n/.exec(block)?.[1] ?? "";
        if (block.includes("\r\nSTATUS:TENTATIVE\r\n")) expect(summary).toMatch(PREFIXES[lang]);
        if (block.includes("\r\nSTATUS:CONFIRMED\r\n")) expect(summary).not.toMatch(/^\[/);
      }
    }
  });

  test("builds are deterministic", () => {
    expect(buildCountryCalendars(co, config, MESSAGES, TODAY, SITE)).toEqual(files);
  });
});

describe("buildAllCalendars", () => {
  const countries = loadCountries("data/countries");
  const draft: Country = { ...co, country: "ZZ", status: "borrador", festivals: [] };

  test("drafts are left out unless INCLUDE_DRAFTS is on", () => {
    const base = { countries: [...countries, draft], config, messages: MESSAGES, siteUrl: SITE, today: TODAY };
    expect(buildAllCalendars({ ...base, includeDrafts: false }).some((f) => f.path.startsWith("calendars/zz"))).toBe(false);
    expect(buildAllCalendars({ ...base, includeDrafts: true }).map((f) => f.path)).toContain("calendars/zz.ics");
  });

  test("fails, naming each key, when a locale lacks a calendar string", () => {
    const { ["ics.prefix.tentative"]: _drop, ...enWithoutPrefix } = EN;
    const messages = { ...MESSAGES, en: enWithoutPrefix };
    expect(() => buildAllCalendars({ countries, config, messages, siteUrl: SITE, today: TODAY, includeDrafts: false })).toThrow(
      /en: ics\.prefix\.tentative/,
    );
  });

  test("rejects a site URL that is not http(s)", () => {
    expect(() => buildAllCalendars({ countries, config, messages: MESSAGES, siteUrl: "not a url", today: TODAY, includeDrafts: false })).toThrow(
      /SITE_URL/,
    );
    expect(() => buildAllCalendars({ countries, config, messages: MESSAGES, siteUrl: "javascript:alert(1)", today: TODAY, includeDrafts: false })).toThrow(
      /SITE_URL/,
    );
  });
});

describe("writeCalendars", () => {
  test("replaces the calendars folder with the new feeds", () => {
    const out = tmp();
    mkdirSync(join(out, "calendars"));
    writeFileSync(join(out, "calendars", "stale.ics"), "old");
    writeCalendars([{ path: "calendars/co.ics", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", events: 0 }], out);
    expect(existsSync(join(out, "calendars", "stale.ics"))).toBe(false);
    expect(readFileSync(join(out, "calendars", "co.ics"), "utf8")).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  });
});
