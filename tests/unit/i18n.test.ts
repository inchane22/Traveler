// Every visible string comes from locales/*.json; es, en and pt must stay in sync (RF-11).
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createI18n, detectLang, isLang, keyDiff, LANGS, type Messages } from "../../src/i18n.ts";
import { FESTIVAL_TYPES, REGIONS } from "../../src/router.ts";
import { CRITERIA } from "../../src/score.ts";
import { Confidence, Status } from "../../src/schema.ts";
import { REQUIRED_KEYS } from "../../scripts/build-calendars.ts";
import type { Lang } from "../../src/schema.ts";

const ROOT = join(import.meta.dirname, "../..");
const load = (lang: Lang): Messages => JSON.parse(readFileSync(join(ROOT, "locales", `${lang}.json`), "utf8")) as Messages;
const ALL: Record<Lang, Messages> = { es: load("es"), en: load("en"), pt: load("pt") };
const has = (m: Messages, key: string): boolean => key in m || `${key}.one` in m || `${key}.other` in m;
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ""))].sort();

describe("locale files", () => {
  test.each(["en", "pt"] as const)("es and %s have identical key sets", (lang) => {
    expect(keyDiff(ALL.es, ALL[lang])).toEqual({ missing: [], extra: [] });
  });

  test.each(LANGS)("%s has no empty strings", (lang) => {
    const empty = Object.entries(ALL[lang]).filter(([, v]) => typeof v !== "string" || !v.trim());
    expect(empty).toEqual([]);
  });

  test.each(["en", "pt"] as const)("%s uses the same {placeholders} as es for every key", (lang) => {
    const mismatched = Object.keys(ALL.es).filter((k) => placeholders(ALL.es[k] ?? "").join() !== placeholders(ALL[lang][k] ?? "").join());
    expect(mismatched).toEqual([]);
  });

  test("every literal key the UI asks for exists", () => {
    const dir = join(ROOT, "src/render");
    const sources = [...readdirSync(dir).map((f) => join(dir, f)), join(ROOT, "src/app.ts")].map((f) => readFileSync(f, "utf8"));
    const used = new Set(sources.flatMap((src) => [...src.matchAll(/\bt\(\s*"([\w.-]+)"/g)].map((m) => m[1] ?? "")));
    expect(used.size).toBeGreaterThan(100);
    for (const lang of LANGS) expect([...used].filter((k) => !has(ALL[lang], k)), lang).toEqual([]);
  });

  test("every key family built at runtime is complete", () => {
    const families = [
      ...FESTIVAL_TYPES.map((t) => `type.${t}`),
      ...Status.options.flatMap((s) => [`status.${s}`, `about.status.${s}`]),
      ...Confidence.options.flatMap((c) => [`confidence.${c}`, `about.confidence.${c}`]),
      ...REGIONS.map((r) => `region.${r}`),
      ...CRITERIA.flatMap((c) => [`criterion.${c}`, `about.criterion.${c}`]),
      ...["1", "2", "provisional", "hidden"].map((t) => `tier.${t}`),
      ...["solid", "hatched", "window"].map((m) => `timeline.pattern.${m}`),
    ];
    for (const lang of LANGS) expect(families.filter((k) => !has(ALL[lang], k)), lang).toEqual([]);
  });

  test("the calendar build finds every key it requires", () => {
    for (const lang of LANGS) expect(REQUIRED_KEYS.filter((k) => !has(ALL[lang], k)), lang).toEqual([]);
  });
});

describe("createI18n", () => {
  test("pluralizes through Intl.PluralRules", () => {
    const es = createI18n(ALL, "es");
    expect(es.t("explore.results", { count: 1 })).toBe("1 fiesta");
    expect(es.t("explore.results", { count: 3 })).toBe("3 fiestas");
    expect(es.t("explore.results", { count: 0 })).toBe("0 fiestas");
    const en = createI18n(ALL, "en");
    expect(en.t("explore.results", { count: 1 })).toMatch(/^1 \w+$/);
    expect(en.t("explore.results", { count: 1 })).not.toBe(en.t("explore.results", { count: 2 }).replace("2", "1"));
  });

  test("formats numeric params with the locale's digits grouping", () => {
    const t = createI18n({ es: { n: "{count} ok" }, en: { n: "{count} ok" }, pt: {} }, "en").t;
    expect(t("n", { count: 12345 })).toBe("12,345 ok");
  });

  test("uses an explicit zero form when the locale defines one", () => {
    const dict = { "x.zero": "none", "x.one": "one", "x.other": "{count}" };
    const t = createI18n({ es: dict, en: dict, pt: dict }, "pt").t;
    expect(t("x", { count: 0 })).toBe("none");
    expect(t("x", { count: 1 })).toBe("one");
    expect(t("x", { count: 7 })).toBe("7");
  });

  test("falls back to Spanish, then to the key itself", () => {
    const i18n = createI18n({ es: { only: "solo es" }, en: {}, pt: {} }, "en");
    expect(i18n.t("only")).toBe("solo es");
    expect(i18n.t("missing.key")).toBe("missing.key");
    expect(i18n.has("only")).toBe(true);
    expect(i18n.has("missing.key")).toBe(false);
  });

  test("leaves unknown placeholders visible", () => {
    const t = createI18n({ es: { k: "{a} y {b}" }, en: {}, pt: {} }, "es").t;
    expect(t("k", { a: "x" })).toBe("x y {b}");
  });
});

describe("detectLang", () => {
  test("picks the first supported base language", () => {
    expect(detectLang(["es-PE", "en"])).toBe("es");
    expect(detectLang(["fr-FR", "pt-BR"])).toBe("pt");
    expect(detectLang(["EN_us"])).toBe("en");
  });

  test("defaults to Spanish", () => {
    expect(detectLang([])).toBe("es");
    expect(detectLang(undefined)).toBe("es");
    expect(detectLang(["de", "ja"])).toBe("es");
  });

  test("isLang accepts only es, en and pt", () => {
    expect(LANGS.every(isLang)).toBe(true);
    expect(isLang("fr")).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});
