// One bad change can no longer abort the weekly run (code-F2, SEC-01): validation rejects what the
// schema would refuse, confirmations never rewrite a stored figure, and a trial apply moves anything
// that still breaks a country file to «para revisar» before the report is written.
import { describe, expect, test } from "vitest";
import { dataProblems } from "../../scripts/build-data.ts";
import { applyChanges, trialApply } from "../../scripts/lib/apply.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { demoteUnappliable } from "../../scripts/lib/refresh-run.ts";
import { selectForApply } from "../../scripts/lib/select.ts";
import { checkConfirmedStatus, reviewChange, type ReviewContext } from "../../scripts/lib/validate.ts";
import { ctxFor } from "../../src/festivals.ts";
import type { CountryFile, Festival } from "../../src/schema.ts";
import { accepted as acceptedIn, cited, edition, fest, nation, source } from "../fixtures/pipeline/synthetic.ts";
import { coPolicy, country as stored } from "../fixtures/pipeline/helpers.ts";

const TODAY = "2026-10-26";
const accepted: typeof acceptedIn = (over = {}) => acceptedIn({ country: "CO", ...over });
const rule = { type: "announced", window: { start: "01-02", end: "01-07" } };
const policies = new Map([["CO", coPolicy]]);

function withScore(f: Festival): Festival {
  return { ...f, score: { ...f.score, convocatoria: { measure: { attendance: 250000, qualifier: "about", unit: "tourists", year: 2026 }, confidence: "prensa", source: "https://www.eltiempo.com/pasto", note: { es: "Balance de la Alcaldía." } } } };
}

describe("status «confirmada» needs dates and a source on the resulting edition (code-F2)", () => {
  const nyb = fest("CO", "negros-y-blancos", rule, { "2027": edition({ status: "tentativa", confidence: "patron" }) });
  const ctx = { festival: nyb, year: 2027 } as unknown as ReviewContext;
  const status = accepted({ slug: "negros-y-blancos", year: 2027, field: "status", old: "tentativa", new: "confirmada", sources: [cited("https://carnavaldepasto.org/x")] });

  test("rejected when the edition would have no start and end", () => {
    const [out] = checkConfirmedStatus([status], ctx);
    expect(out).toMatchObject({ verdict: "rejected" });
    expect(out!.reasons.join()).toMatch(/«confirmada» sin inicio, fin/);
  });

  test("kept when accepted start and end come with it", () => {
    const start = accepted({ slug: "negros-y-blancos", year: 2027, field: "start", old: null, new: "2027-01-02", sources: [cited("https://carnavaldepasto.org/x")] });
    const end = accepted({ slug: "negros-y-blancos", year: 2027, field: "end", old: null, new: "2027-01-07", sources: [cited("https://carnavaldepasto.org/x")] });
    expect(checkConfirmedStatus([status, start, end], ctx).map((c) => c.verdict)).toEqual(["accepted", "accepted", "accepted"]);
  });

  test("applying it alone throws today, so the trial apply sends it to review instead", () => {
    const country = nation("CO", [nyb]);
    expect(() => applyChanges(country, [status], TODAY)).toThrow(/a confirmed edition needs start and end/);
    const other = accepted({ slug: "negros-y-blancos", year: 2027, field: "confidence", old: "patron", new: "prensa", sources: [cited("https://www.eltiempo.com/x")] });
    const { ok, failed } = trialApply([country], [status, other], TODAY, policies);
    expect(ok).toEqual([other]);
    expect(failed.map((f) => f.change)).toEqual([status]);
    const selection = demoteUnappliable(selectForApply([status, other]), [country], TODAY, memoryLogger(), policies);
    expect(selection.applied).toEqual([other]);
    expect(selection.flagged).toHaveLength(1);
    expect(selection.flagged[0]!.flags.join()).toMatch(/no se puede aplicar/);
  });
});

describe("score confirmations never rewrite the stored figure (SEC-01)", () => {
  const pasto = withScore(fest("CO", "negros-y-blancos", rule));
  const country = nation("CO", [pasto]);

  test("a yearless quote no longer crashes apply: the confirmation keeps measure and note", () => {
    const confirm = accepted({ slug: "negros-y-blancos", year: 2027, field: "score.convocatoria", old: 250000, new: 250000, kind: "confirmation", quote: "Llegaron 250.000 turistas", quote_url: "https://www.eltiempo.com/pasto", confidence: "prensa", sources: [cited("https://www.eltiempo.com/pasto")] });
    const next = applyChanges(country, [confirm], TODAY);
    const conv = next.festivals[0]!.score.convocatoria!;
    expect(conv.measure).toEqual({ attendance: 250000, qualifier: "about", unit: "tourists", year: 2026 });
    expect(conv.note?.es).toBe("Balance de la Alcaldía.");
  });

  test("validation flags a figure without a year even when it only confirms", () => {
    const text = "Llegaron 250.000 turistas al carnaval";
    const ctx: ReviewContext = { country: "CO", festival: pasto, tier: 1, year: 2027, daysToStart: 68, citations: [{ url: "https://www.eltiempo.com/pasto", title: "x", cited_text: text }], policy: coPolicy, ruleCtx: ctxFor(country) };
    const out = reviewChange({ field: "score.convocatoria", old: 250000, new: 250000, source_urls: ["https://www.eltiempo.com/pasto"], quote: text, quote_language: "es", confidence: "prensa", note: "" }, ctx);
    expect(out.kind).toBe("confirmation");
    expect(out.verdict).toBe("flagged");
    expect(out.flags.join()).toMatch(/no dice de qué año/);
  });

  test("a yearless figure change that reaches apply throws a clear error, and the trial apply catches it", () => {
    const change = accepted({ slug: "negros-y-blancos", year: 2027, field: "score.convocatoria", old: 250000, new: 300000, quote: "Llegaron 300.000 turistas", sources: [cited("https://www.eltiempo.com/pasto")] });
    expect(() => applyChanges(country, [change], TODAY)).toThrow(/states no year/);
    expect(trialApply([country], [change], TODAY, policies).failed).toHaveLength(1);
    expect(source("https://www.eltiempo.com/pasto").url).toBe("https://www.eltiempo.com/pasto");
  });
});

/** What the weekly run would write for these changes: demoted first, then applied. */
function weeklyApply(country: CountryFile, changes: ReturnType<typeof accepted>[]) {
  const selection = demoteUnappliable(selectForApply(changes), [country], TODAY, memoryLogger(), policies);
  return { selection, next: applyChanges(country, [...selection.applied, ...selection.confirmations], TODAY) };
}

describe("nothing the trial apply lets through is rejected later by build-data (BE-01)", () => {
  const TIER_C = "https://www.someblog.example.com/carnaval";
  const pasto = withScore(fest("CO", "negros-y-blancos", rule));
  const country = nation("CO", [pasto]);
  const ctxWith = (texts: Record<string, string>): ReviewContext => ({
    country: "CO", festival: pasto, tier: 2, year: 2027, daysToStart: 68,
    citations: Object.entries(texts).map(([url, cited_text]) => ({ url, title: "x", cited_text })), policy: coPolicy, ruleCtx: ctxFor(country),
  });
  const figure = (urls: string[], confidence: "oficial" | "prensa") => ({ field: "score.convocatoria", old: 250000, new: 900000, source_urls: urls, quote: "En 2026 llegaron 900.000 turistas", quote_language: "es", confidence, note: "" });

  test("a press confirmation of the party classification keeps the official source and quote", () => {
    const co = stored("CO");
    const party = co.festivals.find((f) => f.slug === "carnaval-barranquilla")!.score.fiesta!;
    expect(party.confidence).toBe("oficial");
    const press = "https://www.eltiempo.com/cultura/carnaval-se-baila-en-la-calle";
    const confirm = accepted({ slug: "carnaval-barranquilla", field: "score.fiesta", old: "baile_abierto", new: "baile_abierto", kind: "confirmation", quote: "se baila en la calle", quote_url: press, confidence: "prensa", sources: [cited(press)] });
    const { selection, next } = weeklyApply(co, [confirm]);
    expect(selection.confirmations).toHaveLength(1);
    expect(next.festivals.find((f) => f.slug === "carnaval-barranquilla")!.score.fiesta).toEqual(party);
    expect(dataProblems([next], policies, TODAY)).toEqual([]);
  });

  test("a figure labelled «oficial» whose only source is tier C ends up «estimacion»", () => {
    const out = reviewChange(figure([TIER_C], "oficial"), ctxWith({ [TIER_C]: "En 2026 llegaron 900.000 turistas al carnaval" }));
    expect(out).toMatchObject({ verdict: "accepted", confidence: "estimacion" });
    expect(dataProblems([weeklyApply(country, [out]).next], policies, TODAY)).not.toContainEqual(expect.stringContaining("negros-y-blancos score"));
  });

  test("an official URL cited without the quote does not lend «oficial» to the tier-C page that holds it", () => {
    const gov = "https://www.gov.co/fiestas";
    const out = reviewChange(figure([gov, TIER_C], "oficial"), ctxWith({ [gov]: "Programación del carnaval", [TIER_C]: "En 2026 llegaron 900.000 turistas al carnaval" }));
    expect(out.quote_url).toBe(TIER_C);
    expect(out.confidence).toBe("estimacion");
    expect(dataProblems([weeklyApply(country, [out]).next], policies, TODAY)).not.toContainEqual(expect.stringContaining("negros-y-blancos score"));
  });

  test("backstop: a change build-data would reject is sent to review instead of reaching the files", () => {
    const bad = accepted({ slug: "negros-y-blancos", field: "score.convocatoria", old: 250000, new: 900000, quote: "En 2026 llegaron 900.000 turistas", quote_url: TIER_C, confidence: "oficial", sources: [{ ...cited(TIER_C), tier: "C" }] });
    const { selection, next } = weeklyApply(country, [bad]);
    expect(selection.applied).toEqual([]);
    expect(selection.flagged[0]!.flags.join()).toMatch(/no se puede aplicar.*«oficial» needs a source on config\/official-domains/);
    expect(next).toBe(country);
  });

  test("a problem the country already had does not block unrelated changes", () => {
    // nation() is «publicado» with one festival, so build-data already reports MIN_SOURCED for it.
    expect(dataProblems([country], policies, TODAY)).toHaveLength(1);
    const ok = accepted({ slug: "negros-y-blancos", year: 2027, field: "confidence", old: "patron", new: "prensa", sources: [cited("https://www.eltiempo.com/x")] });
    expect(trialApply([country], [ok], TODAY, policies)).toEqual({ ok: [ok], failed: [] });
  });
});
