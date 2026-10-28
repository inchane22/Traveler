import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCalendar,
  calendarPath,
  countryName,
  escapeText,
  eventFor,
  foldLine,
  formatDtstamp,
  googleCalendarUrl,
  outlookCalendarUrl,
  statusFor,
  webcalUrl,
  type IcsEvent,
  type Translate,
} from "../../src/ics.ts";
import { buildEntries, ctxFor, occurrencesBetween, type FestivalEntry } from "../../src/festivals.ts";
import { CountryFile, type CountryFile as Country } from "../../src/schema.ts";
import type { ScoringConfig } from "../../src/score.ts";

// Test-only strings: the module takes `t` as an argument, so its tests never depend on locales/.
const ES: Record<string, string> = {
  "ics.prefix.tentative": "[Por confirmar]",
  "ics.prefix.cancelled": "[Cancelada]",
  "ics.prefix.postponed": "[Aplazada]",
  "ics.description": "Estado: {status}. Confianza: {confidence}. Ficha: {url}",
  "ics.calendarName": "Fiestas de {country}",
  "status.confirmada": "Confirmada",
  "status.tentativa": "Tentativa",
  "status.por_anunciar": "Por anunciar",
  "status.aplazada": "Aplazada",
  "status.cancelada": "Cancelada",
  "confidence.oficial": "Oficial",
  "confidence.prensa": "Prensa",
  "confidence.patron": "Patrón",
  "confidence.estimacion": "Estimación",
};

const t: Translate = (key, params) => {
  const template = ES[key];
  if (template === undefined) throw new Error(`missing key ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`));
};

const config = JSON.parse(readFileSync("config/scoring.json", "utf8")) as ScoringConfig;
const rawCo = JSON.parse(readFileSync("data/countries/co.json", "utf8")) as unknown;
const co = CountryFile.parse(rawCo);
const TODAY = "2026-10-26";
const SITE = "https://example.test/traveler/";
const DTSTAMP = "20261026T000000Z";
const entries = buildEntries(co, config, TODAY);

function entry(slug: string, list: readonly FestivalEntry[] = entries): FestivalEntry {
  const found = list.find((e) => e.festival.slug === slug);
  if (!found) throw new Error(`missing festival ${slug}`);
  return found;
}

function mustEvent(source: FestivalEntry, lang: "es" | "en" | "pt" = "es"): IcsEvent {
  const ev = eventFor(source, lang, t, SITE);
  if (!ev) throw new Error(`no event for ${source.festival.slug}`);
  return ev;
}

/** RFC 5545 3.1: a CRLF followed by one space or tab is removed when reading. */
const unfold = (ics: string): string => ics.replace(/\r\n[ \t]/g, "");
const physicalLines = (ics: string): string[] => ics.split("\r\n").slice(0, -1);
const octets = (s: string): number => Buffer.byteLength(s, "utf8");

/** Copy of CO with one edition of a festival replaced, validated by the real schema. */
function withEdition(slug: string, year: string, patch: Record<string, unknown>): Country {
  const copy = structuredClone(rawCo) as { festivals: Array<{ slug: string; editions: Record<string, Record<string, unknown>> }> };
  const festival = copy.festivals.find((f) => f.slug === slug);
  if (!festival) throw new Error(`missing festival ${slug}`);
  festival.editions[year] = { ...festival.editions[year], ...patch };
  return CountryFile.parse(copy);
}

describe("statusFor", () => {
  test("maps every festival status onto an iCalendar STATUS", () => {
    expect(statusFor("confirmada")).toBe("CONFIRMED");
    expect(statusFor("cancelada")).toBe("CANCELLED");
    expect(statusFor("tentativa")).toBe("TENTATIVE");
    expect(statusFor("por_anunciar")).toBe("TENTATIVE");
    expect(statusFor("aplazada")).toBe("TENTATIVE");
  });
});

describe("eventFor", () => {
  test("Barranquilla 2027 is a confirmed all-day event with a stable UID", () => {
    const ev = mustEvent(entry("carnaval-barranquilla"));
    expect(ev).toMatchObject({
      uid: "carnaval-barranquilla-2027@traveler",
      start: "2027-02-06",
      end: "2027-02-09",
      status: "CONFIRMED",
      sequence: 0,
      summary: "Carnaval de Barranquilla",
      location: "Barranquilla, Colombia",
      url: "https://example.test/traveler/#/fiesta/carnaval-barranquilla",
    });
    expect(ev.description).toContain("Estado: Confirmada. Confianza: Oficial. Ficha: https://example.test/traveler/#/fiesta/carnaval-barranquilla");
    expect(ev.description).toContain("Carnaval de la 44");
  });

  test("uses the festival name and country name of the requested language", () => {
    expect(mustEvent(entry("carnaval-barranquilla"), "en")).toMatchObject({ summary: "Barranquilla Carnival", location: "Barranquilla, Colombia" });
    expect(mustEvent(entry("carnaval-barranquilla"), "pt").description).toContain("O Carnaval de la 44");
  });

  test("adds the trailing slash a site URL is missing", () => {
    expect(eventFor(entry("carnaval-barranquilla"), "es", t, "https://example.test/traveler")?.url).toBe(
      "https://example.test/traveler/#/fiesta/carnaval-barranquilla",
    );
  });

  test("Cartagena 2026, a tentative edition without dates, takes the rule's days, is TENTATIVE and carries the tentative mark", () => {
    const cartagena = entry("independencia-cartagena");
    expect(cartagena.occurrence).toMatchObject({ start: "2026-11-10", end: "2026-11-16", status: "tentativa", confidence: "patron", origin: "edition" });
    const ev = mustEvent(cartagena);
    expect(ev.status).toBe("TENTATIVE");
    expect(ev.summary).toBe("[Por confirmar] Fiestas de la Independencia de Cartagena");
    expect(ev.sequence).toBe(0);
    expect(ev.uid).toBe("independencia-cartagena-2026@traveler");
  });

  test("a simulated cancellation keeps the UID, raises SEQUENCE and publishes CANCELLED (RF-18)", () => {
    const before = mustEvent(entry("carnaval-barranquilla"));
    const cancelledCo = withEdition("carnaval-barranquilla", "2027", { status: "cancelada", sequence: before.sequence + 1 });
    const after = mustEvent(entry("carnaval-barranquilla", buildEntries(cancelledCo, config, TODAY)));

    expect(after.uid).toBe(before.uid);
    expect(after.status).toBe("CANCELLED");
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(after.summary).toBe("[Cancelada] Carnaval de Barranquilla");

    const ics = unfold(buildCalendar([after], { name: "Fiestas de Colombia", dtstamp: DTSTAMP }));
    expect(ics).toContain("\r\nSTATUS:CANCELLED\r\n");
    expect(ics).toContain("\r\nSEQUENCE:1\r\n");
  });

  test("a postponed edition stays TENTATIVE with the postponed mark", () => {
    const postponed = withEdition("carnaval-barranquilla", "2027", { status: "aplazada", sequence: 1 });
    const ev = mustEvent(entry("carnaval-barranquilla", buildEntries(postponed, config, TODAY)));
    expect(ev.status).toBe("TENTATIVE");
    expect(ev.summary).toBe("[Aplazada] Carnaval de Barranquilla");
  });

  test("refuses to export an unconfirmed event when the mark has no translation", () => {
    const cartagena = entry("independencia-cartagena");
    const echoKey: Translate = (key) => key;
    const blank: Translate = (key, params) => (key.startsWith("ics.prefix.") ? " " : t(key, params));
    expect(() => eventFor(cartagena, "es", echoKey, SITE)).toThrow(/ics\.prefix\.tentative/);
    expect(() => eventFor(cartagena, "es", blank, SITE)).toThrow(/ics\.prefix\.tentative/);
    expect(eventFor(entry("carnaval-barranquilla"), "es", echoKey, SITE)?.summary).toBe("Carnaval de Barranquilla");
  });

  test("festivals with only a probable window, or no occurrence, produce no event", () => {
    const petronio = entry("petronio-alvarez");
    expect(petronio.occurrence?.start).toBeUndefined();
    expect(petronio.occurrence?.window).toBeDefined();
    expect(eventFor(petronio, "es", t, SITE)).toBeNull();
    expect(eventFor({ ...petronio, occurrence: null }, "es", t, SITE)).toBeNull();
  });

  test("no unconfirmed event is ever exported without its mark", () => {
    const ctx = ctxFor(co);
    const events = entries.flatMap((e) =>
      occurrencesBetween(e.festival, "2026-08-26", "2027-10-26", ctx)
        .map((occurrence) => eventFor({ festival: e.festival, occurrence, country: e.country }, "es", t, SITE))
        .filter((ev): ev is IcsEvent => ev !== null),
    );
    expect(events.length).toBeGreaterThan(3);
    for (const ev of events) {
      if (ev.status === "CONFIRMED") expect(ev.summary).not.toMatch(/^\[/);
      if (ev.status === "TENTATIVE") expect(ev.summary).toMatch(/^\[(Por confirmar|Aplazada)\] /);
      if (ev.status === "CANCELLED") expect(ev.summary).toMatch(/^\[Cancelada\] /);
    }
  });
});

describe("buildCalendar", () => {
  const barranquilla = mustEvent(entry("carnaval-barranquilla"));
  const cartagena = mustEvent(entry("independencia-cartagena"));
  const ics = buildCalendar([barranquilla, cartagena], { name: "Fiestas de Colombia", dtstamp: DTSTAMP });
  const text = unfold(ics);

  test("writes a publishable VCALENDAR with subscription refresh hints", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    for (const line of [
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Fiestas de Colombia",
      "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
      "X-PUBLISHED-TTL:PT12H",
    ]) {
      expect(text).toContain(`\r\n${line}\r\n`);
    }
  });

  test("Barranquilla 2027 runs 6 to 9 Feb, so DTEND is the exclusive 10 Feb", () => {
    for (const line of [
      "UID:carnaval-barranquilla-2027@traveler",
      "DTSTAMP:20261026T000000Z",
      "DTSTART;VALUE=DATE:20270206",
      "DTEND;VALUE=DATE:20270210",
      "SUMMARY:Carnaval de Barranquilla",
      "LOCATION:Barranquilla\\, Colombia",
      "URL:https://example.test/traveler/#/fiesta/carnaval-barranquilla",
      "STATUS:CONFIRMED",
      "SEQUENCE:0",
      "TRANSP:TRANSPARENT",
    ]) {
      expect(text).toContain(`\r\n${line}\r\n`);
    }
  });

  test("the tentative Cartagena event is TENTATIVE with the mark in SUMMARY", () => {
    expect(text).toContain("\r\nSUMMARY:[Por confirmar] Fiestas de la Independencia de Cartagena\r\n");
    expect(text).toContain("\r\nDTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261117\r\n");
    expect(text).toMatch(/UID:independencia-cartagena-2026@traveler[\s\S]*?STATUS:TENTATIVE/);
  });

  test("uses CRLF only and keeps every physical line within 75 octets", () => {
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of physicalLines(ics)) expect(octets(line)).toBeLessThanOrEqual(75);
  });

  test("orders events by date, then UID, whatever the input order", () => {
    const reversed = buildCalendar([cartagena, barranquilla], { name: "Fiestas de Colombia", dtstamp: DTSTAMP });
    expect(reversed).toBe(ics);
    expect(text.indexOf("UID:independencia-cartagena-2026")).toBeLessThan(text.indexOf("UID:carnaval-barranquilla-2027"));
  });

  test("an empty calendar is still a valid VCALENDAR", () => {
    const empty = buildCalendar([], { name: "Vacío", dtstamp: DTSTAMP });
    expect(empty.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(empty).not.toContain("BEGIN:VEVENT");
    expect(empty.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  test("escapes calendar names and leaves optional properties out when absent", () => {
    const bare: IcsEvent = { uid: "x-2027@traveler", start: "2027-01-01", end: "2027-01-01", summary: "X", status: "CONFIRMED", sequence: 2 };
    const out = unfold(buildCalendar([bare], { name: "Fiestas; Colombia, 2027", dtstamp: DTSTAMP }));
    expect(out).toContain("\r\nX-WR-CALNAME:Fiestas\\; Colombia\\, 2027\r\n");
    expect(out).toContain("\r\nDTEND;VALUE=DATE:20270102\r\n");
    expect(out).toContain("\r\nSEQUENCE:2\r\n");
    expect(out).not.toMatch(/\r\n(DESCRIPTION|LOCATION|URL)[:;]/);
  });

  test("rejects a malformed DTSTAMP and an event that ends before it starts", () => {
    expect(() => buildCalendar([], { name: "X", dtstamp: "2026-10-26" })).toThrow(/DTSTAMP/);
    const backwards: IcsEvent = { ...barranquilla, start: "2027-02-10", end: "2027-02-09" };
    expect(() => buildCalendar([backwards], { name: "X", dtstamp: DTSTAMP })).toThrow(/before/);
    expect(() => buildCalendar([{ ...barranquilla, sequence: -1 }], { name: "X", dtstamp: DTSTAMP })).toThrow(/SEQUENCE/);
    const badStatus = { ...barranquilla, status: "DONE" } as unknown as IcsEvent;
    expect(() => buildCalendar([badStatus], { name: "X", dtstamp: DTSTAMP })).toThrow(/STATUS/);
  });
});

describe("text escaping (RFC 5545 3.3.11)", () => {
  test("escapes backslash, semicolon, comma and every newline form", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
  });

  test("drops control characters other than tab", () => {
    expect(escapeText("a\u0000b\u0007c\td\u007f")).toBe("abc\td");
  });

  test("escaped data in a DESCRIPTION round-trips through the calendar", () => {
    const ev: IcsEvent = {
      uid: "x-2027@traveler",
      start: "2027-01-01",
      end: "2027-01-02",
      summary: "Feria; música, baile",
      description: "Línea 1\nLínea 2",
      status: "CONFIRMED",
      sequence: 0,
    };
    const out = unfold(buildCalendar([ev], { name: "X", dtstamp: DTSTAMP }));
    expect(out).toContain("\r\nSUMMARY:Feria\\; música\\, baile\r\n");
    expect(out).toContain("\r\nDESCRIPTION:Línea 1\\nLínea 2\r\n");
  });
});

describe("line folding (RFC 5545 3.1)", () => {
  test("a short line is left alone, 75 octets exactly is not folded", () => {
    expect(foldLine("SUMMARY:Hola")).toBe("SUMMARY:Hola");
    expect(foldLine("X".repeat(75))).toBe("X".repeat(75));
  });

  test("continuation lines start with one space and carry at most 74 octets of content", () => {
    expect(foldLine("X".repeat(76))).toBe(`${"X".repeat(75)}\r\n X`);
    expect(foldLine("X".repeat(75 + 74 + 1)).split("\r\n")).toEqual(["X".repeat(75), ` ${"X".repeat(74)}`, " X"]);
  });

  test("never splits a multi-byte character across lines", () => {
    expect(foldLine(`${"X".repeat(74)}ñY`)).toBe(`${"X".repeat(74)}\r\n ñY`);
    expect(foldLine(`${"X".repeat(73)}😀`)).toBe(`${"X".repeat(73)}\r\n 😀`);
  });

  test("a long Spanish line with accents folds within 75 octets and unfolds to the original", () => {
    const sentence = "Información: desfiles, comparsas, música y tradición; ¡añoranza, corazón y alegría en cada rincón de Pasto! ";
    const line = `DESCRIPTION:${sentence.repeat(4)}`;
    const folded = foldLine(line);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const [i, l] of lines.entries()) {
      expect(octets(l)).toBeLessThanOrEqual(75);
      if (i > 0) expect(l.startsWith(" ")).toBe(true);
    }
    expect(unfold(folded)).toBe(line);
  });

  test("a whole calendar with long accented descriptions keeps every line within 75 octets", () => {
    const ev: IcsEvent = {
      uid: "negros-y-blancos-2027@traveler",
      start: "2027-01-02",
      end: "2027-01-07",
      summary: "[Por confirmar] Carnaval de Negros y Blancos, Patrimonio Cultural Inmaterial de la Humanidad",
      description: "Celebración del reencuentro y la reconciliación: «el día de los negritos» y «el día de los blanquitos» llenan la ciudad de pintura y talco.\n\nÑapa: llévate gafas.",
      location: "San Juan de Pasto, Nariño, Colombia",
      url: `${SITE}#/fiesta/negros-y-blancos`,
      status: "TENTATIVE",
      sequence: 0,
    };
    const ics = buildCalendar([ev], { name: "Fiestas de Colombia (español)", dtstamp: DTSTAMP });
    for (const line of physicalLines(ics)) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(unfold(ics)).toContain(`\r\nURL:${SITE}#/fiesta/negros-y-blancos\r\n`);
  });
});

describe("add-to-calendar links", () => {
  const ev = mustEvent(entry("carnaval-barranquilla"));

  test("Google Calendar gets an https TEMPLATE link with the exclusive end date", () => {
    const link = googleCalendarUrl(ev);
    expect(link.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE&")).toBe(true);
    expect(link).toContain("&dates=20270206/20270210");
    const params = new URL(link).searchParams;
    expect(params.get("text")).toBe("Carnaval de Barranquilla");
    expect(params.get("location")).toBe("Barranquilla, Colombia");
    expect(params.get("details")).toBe(ev.description);
  });

  test("Outlook gets an https all-day compose deeplink", () => {
    const url = new URL(outlookCalendarUrl(ev));
    expect(url.protocol).toBe("https:");
    expect(`${url.host}${url.pathname}`).toBe("outlook.live.com/calendar/0/deeplink/compose");
    expect(url.searchParams.get("allday")).toBe("true");
    expect(url.searchParams.get("startdt")).toBe("2027-02-06");
    expect(url.searchParams.get("enddt")).toBe("2027-02-10");
    expect(url.searchParams.get("subject")).toBe("Carnaval de Barranquilla");
    expect(url.searchParams.get("location")).toBe("Barranquilla, Colombia");
    expect(url.searchParams.get("body")).toBe(ev.description);
  });

  test("the tentative mark travels into both links", () => {
    const tentative = mustEvent(entry("independencia-cartagena"));
    expect(new URL(googleCalendarUrl(tentative)).searchParams.get("text")).toMatch(/^\[Por confirmar\] /);
    expect(new URL(outlookCalendarUrl(tentative)).searchParams.get("subject")).toMatch(/^\[Por confirmar\] /);
  });

  test("an event without description falls back to its URL as details", () => {
    const bare: IcsEvent = { ...ev, description: undefined };
    expect(new URL(googleCalendarUrl(bare)).searchParams.get("details")).toBe(ev.url);
    expect(new URL(outlookCalendarUrl(bare)).searchParams.get("body")).toBe(ev.url);
  });
});

describe("helpers", () => {
  test("formatDtstamp writes UTC basic format", () => {
    expect(formatDtstamp(new Date(Date.UTC(2026, 9, 26, 13, 5, 9)))).toBe("20261026T130509Z");
  });

  test("calendarPath and webcalUrl name the per-country feeds", () => {
    expect(calendarPath("CO", "es")).toBe("calendars/co.ics");
    expect(calendarPath("co", "en")).toBe("calendars/co.en.ics");
    expect(calendarPath("CO", "pt")).toBe("calendars/co.pt.ics");
    expect(webcalUrl("https://inchane22.github.io/traveler/", "CO", "es")).toBe("webcal://inchane22.github.io/traveler/calendars/co.ics");
    expect(webcalUrl("https://inchane22.github.io/traveler", "CO", "en")).toBe("webcal://inchane22.github.io/traveler/calendars/co.en.ics");
  });

  test("countryName localizes the ISO code and falls back to the code", () => {
    expect(countryName("CO", "es")).toBe("Colombia");
    expect(countryName("BR", "en")).toBe("Brazil");
    expect(countryName("BR", "pt")).toBe("Brasil");
    expect(countryName("co", "es")).toBe("Colombia");
    expect(countryName("XY", "es")).toBe("XY");
    expect(countryName("not-a-code", "es")).toBe("not-a-code");
  });
});
