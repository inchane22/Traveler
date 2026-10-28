// One bad change can no longer abort the weekly run (code-F2, SEC-01): validation rejects what the
// schema would refuse, confirmations never rewrite a stored figure, and a trial apply moves anything
// that still breaks a country file to «para revisar» before the report is written.
import { describe, expect, test } from "vitest";
import { applyChanges, trialApply } from "../../scripts/lib/apply.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { demoteUnappliable } from "../../scripts/lib/refresh-run.ts";
import { selectForPr } from "../../scripts/lib/select.ts";
import { checkConfirmedStatus, reviewChange, type ReviewContext } from "../../scripts/lib/validate.ts";
import { ctxFor } from "../../src/festivals.ts";
import type { Festival } from "../../src/schema.ts";
import { accepted as acceptedIn, cited, edition, fest, nation, source } from "../fixtures/pipeline/synthetic.ts";
import { coPolicy } from "../fixtures/pipeline/helpers.ts";

const TODAY = "2026-10-26";
const accepted: typeof acceptedIn = (over = {}) => acceptedIn({ country: "CO", ...over });
const rule = { type: "announced", window: { start: "01-02", end: "01-07" } };

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
    const { ok, failed } = trialApply([country], [status, other], TODAY);
    expect(ok).toEqual([other]);
    expect(failed.map((f) => f.change)).toEqual([status]);
    const selection = demoteUnappliable(selectForPr([status, other], null), [country], TODAY, memoryLogger());
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
    expect(trialApply([country], [change], TODAY).failed).toHaveLength(1);
    expect(source("https://www.eltiempo.com/pasto").url).toBe("https://www.eltiempo.com/pasto");
  });
});
