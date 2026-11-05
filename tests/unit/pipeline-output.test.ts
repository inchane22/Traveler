import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyChanges, changelogEntries, mergeSources, sourcesOf } from "../../scripts/lib/apply.ts";
import { archiveAll, archiverFor, noopArchiver, spnArchiver, waybackUrl, type FetchLike } from "../../scripts/lib/archive.ts";
import { extractionContext, researchUserPrompt } from "../../scripts/lib/festival-context.ts";
import { appendGithubOutput, formatJson, listProposals, loadPrompt, memoryLogger, writeJson, writeText } from "../../scripts/lib/io.ts";
import { details, mdLink, mdTable, mdText } from "../../scripts/lib/markdown.ts";
import { buildQueue } from "../../scripts/lib/queue.ts";
import { buildRefreshReport, fieldLabel, renderRefreshMarkdown, tier1DateCount } from "../../scripts/lib/report.ts";
import { selectForPr } from "../../scripts/lib/select.ts";
import type { ReviewedChange } from "../../scripts/lib/validate.ts";
import { config, country, REPO, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";

const SRC = { url: "https://www.pasto.gov.co/n", host: "pasto.gov.co", domain: "pasto.gov.co", tier: "A" as const, official: true, title: "t" };
const rc = (over: Partial<ReviewedChange> = {}): ReviewedChange => ({
  country: "CO",
  slug: "negros-y-blancos",
  name: "Carnaval de Negros y Blancos",
  tier: 1,
  year: 2027,
  daysToStart: 68,
  field: "start",
  old: null,
  new: "2027-01-02",
  kind: "change",
  sources: [SRC],
  quote_url: SRC.url,
  quote: "del 2 al 7 de enero de 2027",
  quote_language: "es",
  proposed_confidence: "oficial",
  confidence: "oficial",
  note: "n",
  verdict: "accepted",
  flags: [],
  reasons: [],
  adjustments: [],
  risk: 100,
  ...over,
});

describe("JSON files", () => {
  test("formatJson keeps the repo's hand-written style (co.json and changelog.json round-trip unchanged)", () => {
    for (const file of ["data/countries/co.json", "data/changelog.json"]) {
      const raw = readFileSync(join(REPO, file), "utf8");
      expect(`${formatJson(JSON.parse(raw))}\n`, file).toBe(raw);
    }
    expect(formatJson({ b: { c: null, d: 1 } })).toBe('{ "b": { "c": null, "d": 1 } }');
    expect(formatJson({ a: [1, "x"], b: { c: null } })).toBe('{\n  "a": [1, "x"],\n  "b": { "c": null }\n}');
    expect(formatJson({ a: [{ b: 1 }], c: undefined })).toBe('{\n  "a": [\n    { "b": 1 }\n  ]\n}');
    expect(formatJson([])).toBe("[]");
    expect(formatJson({})).toBe("{}");
  });

  test("writes are atomic and create folders; proposals are listed oldest first", () => {
    const root = tempRepo({ countries: [] });
    writeJson(join(root, "proposals", "2026-10-26.json"), { a: 1 });
    writeText(join(root, "proposals", "2026-10-19.md"), "x");
    writeJson(join(root, "proposals", "2026-10-19.json"), []);
    expect(readdirSync(join(root, "proposals")).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(listProposals(root)).toEqual(["2026-10-19.json", "2026-10-26.json"]);
    expect(listProposals(join(root, "nowhere"))).toEqual([]);
  });

  test("$GITHUB_OUTPUT is appended to, single-line only, and skipped without a path", () => {
    const root = tempRepo({ countries: [] });
    const out = join(root, "out");
    writeFileSync(out, "existing=1\n");
    appendGithubOutput(out, { changes: 3, branch: "refresh/2026-10-26" });
    expect(readFileSync(out, "utf8")).toBe("existing=1\nchanges=3\nbranch=refresh/2026-10-26\n");
    expect(() => appendGithubOutput(out, { x: "a\nb" })).toThrow(/single-line/);
    appendGithubOutput(undefined, { x: 1 });
  });

  test("prompts fill every placeholder or fail", () => {
    expect(loadPrompt("extract-system.md")).toMatch(/\S/);
    expect(() => loadPrompt("research-user.md")).toThrow(/missing value/);
  });
});

describe("prompts built from our own data", () => {
  const co = country("CO");
  const queue = buildQueue([co], config, TODAY, { max: 40, perCountry: 10 });
  const item = (slug: string) => queue.find((i) => i.slug === slug)!;

  test("the research prompt carries names, stored values, the usual timing and, 45 days out, the news sweep (R9)", () => {
    const near = researchUserPrompt(item("independencia-cartagena"), co);
    expect(near).toContain("Fiestas de la Independencia de Cartagena");
    expect(near).toMatch(/«cancelado», «aplazado», «suspendido», «cancelled», «postponed», «suspended»/);
    expect(near).toContain("- status: tentativa (confidence prensa)");
    expect(near).toContain("- start: none; end: none");
    expect(researchUserPrompt(item("negros-y-blancos"), co)).toContain("no stored edition for this year");
    const far = researchUserPrompt(item("carnaval-barranquilla"), co);
    expect(far).not.toContain("«cancelado»");
    expect(far).toContain("key event lectura-del-bando: 2027-01-16");
    expect(far).toContain("not a source, do not report it as a fact");
  });

  test("the extraction context is JSON written by code", () => {
    const ctx = extractionContext(item("carnaval-barranquilla"));
    const body = JSON.parse(ctx.slice(ctx.indexOf("```json") + 7, ctx.lastIndexOf("```")));
    expect(body).toMatchObject({ country: "CO", slug: "carnaval-barranquilla", edition: 2027, stored: { start: "2027-02-06", score: { convocatoria: 820_000, calle: "mayoria_gratis" } } });
  });
});

describe("PR body", () => {
  test("Markdown from the web cannot inject links, mentions, HTML or table breaks", () => {
    expect(mdText("[x](https://evil) @user #12 <img> a|b")).toBe("\\[x\\]\\(https:&#47;&#47;evil\\) \\@user \\#12 \\<img\\> a\\|b");
    expect(mdText("a\n\nb")).toBe("a b");
    expect(mdText("abcdef", 4)).toBe("abc…");
    expect(mdText(null)).toBe("—");
    expect(mdLink("x", "javascript:alert(1)")).toBe("x");
    expect(mdLink("x", "http://a.com")).toBe("x");
    expect(mdLink("x", "nope")).toBe("x");
    expect(mdLink("site", "https://a.com/p (1)")).toBe("[site](https://a.com/p%20%281%29)");
    expect(mdTable(["a"], [["1"]])).toBe("| a |\n| --- |\n| 1 |");
    expect(details("s", "b")).toContain("<summary>s</summary>");
  });

  test("tier-1 dates are bold with a checklist; stops, deferrals and flags are spelled out", () => {
    const selection = selectForPr(
      [
        rc(),
        rc({ field: "status", new: "confirmada", risk: 90 }),
        rc({ slug: "feria-de-cali", name: "Feria de Cali", tier: "provisional", field: "end", verdict: "flagged", flags: ["revisar: x"], risk: 70 }),
        rc({ slug: "feria-de-cali", name: "Feria de Cali", tier: "provisional", verdict: "rejected", reasons: ["sin fuente"], sources: [], quote_url: null }),
        rc({ field: "end", kind: "confirmation", new: "2027-01-07" }),
      ],
      null,
      2,
    );
    const report = buildRefreshReport(
      { date: TODAY, model: "m", dry_run: false, stopped: "R10: monthly budget reached", budget: { month: "2026-10", usd: 1.234, budget_usd: 20, level: "ok", searches: 3 }, festivals: [{ country: "CO", slug: "x", year: 2027, tier: "1", days_to_start: 1, reasons: ["soon"], outcome: "api_error", detail: "boom" }], not_found: [] },
      selection,
    );
    const md = renderRefreshMarkdown(report);
    expect(md).toContain("> **La corrida se detuvo:** R10: monthly budget reached");
    expect(md).toContain("| **Nivel 1** | CO | **Carnaval de Negros y Blancos** | **inicio** |");
    expect(md).toContain("- [ ] CO · Carnaval de Negros y Blancos · inicio 2027-01-02");
    expect(md).toContain("Fuera de este PR por el tope de 15 cambios (1)");
    expect(md).toContain("Rechazados por la validación (1)");
    expect(md).toContain("### Confirmaciones (1)");
    expect(md).toContain("US$1.23 de US$20.00 (3 búsquedas");
    expect(md).toContain("CO/x 2027: api_error (boom)");
    expect(tier1DateCount(report.applied)).toBe(1);
    // SEC-04: a web quote or note cannot become a clickable link or smuggle an entity.
    const phishing = "Compra entradas en https://evil.example/login o WWW.evil.example &#64;user del 2 de enero de 2027";
    const poisoned = renderRefreshMarkdown(buildRefreshReport(report, selectForPr([rc({ quote: phishing, note: `ver www.evil.example y http://x.example` })], null)));
    const prose = poisoned.replace(/\]\(https:\/\/[^)\s]+\)/g, "](link)");
    expect(prose).toContain("evil.example");
    expect(prose).not.toMatch(/https?:\/\//i);
    expect(prose).not.toMatch(/www\./i);
    expect(prose).not.toContain("&#64;");
    expect(fieldLabel("key_events.guacherna")).toBe("key_events.guacherna");
  });
});

describe("archive (R13)", () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
  const fake = (responses: Array<{ ok?: boolean; status?: number; body: unknown } | Error>) => {
    const calls: Call[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, ...init });
      const next = responses.shift();
      if (!next) return Promise.reject(new Error("no more responses"));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ ok: next.ok ?? true, status: next.status ?? 200, json: () => Promise.resolve(next.body) });
    };
    return { fetch, calls };
  };
  // Test-only placeholders; real keys come from the ARCHIVE_* secrets.
  const keys = { accessKey: "test-access", secretKey: "test-secret" };
  const sleep = () => Promise.resolve();

  test("Save Page Now: authenticated POST, then status polling until a capture timestamp", async () => {
    const { fetch, calls } = fake([{ body: { job_id: "spn2-abc" } }, { body: { status: "pending" } }, { body: { status: "success", timestamp: "20261026120000", original_url: "https://a.org/x" } }]);
    const url = await spnArchiver({ ...keys, fetch, sleep, log: memoryLogger() }).capture("https://a.org/x");
    expect(url).toBe("https://web.archive.org/web/20261026120000/https://a.org/x");
    expect(calls[0]).toMatchObject({ url: "https://web.archive.org/save", method: "POST", headers: { Authorization: "LOW test-access:test-secret" } });
    expect(calls[0]!.body).toBe("url=https%3A%2F%2Fa.org%2Fx&if_not_archived_within=1d");
    expect(calls[1]!.url).toBe("https://web.archive.org/save/status/spn2-abc");
  });

  test("failures never throw: refused request, capture error, still pending, network error", async () => {
    const run = async (responses: Parameters<typeof fake>[0]) => {
      const log = memoryLogger();
      const result = await spnArchiver({ ...keys, fetch: fake(responses).fetch, sleep, log, maxPolls: 2, pollMs: 1 }).capture("https://a.org/x");
      return { result, log: log.lines.join() };
    };
    expect(await run([{ ok: false, status: 429, body: { message: "too many" } }])).toEqual({ result: null, log: expect.stringContaining("failed (429: too many)") as unknown });
    expect((await run([{ body: { job_id: "j" } }, { body: { status: "error", message: "blocked" } }])).log).toMatch(/failed: blocked/);
    expect((await run([{ body: { job_id: "j" } }, { body: { status: "pending" } }, { body: { status: "pending" } }])).log).toMatch(/still pending after 2/);
    expect((await run([new Error("ECONNRESET")])).log).toMatch(/ECONNRESET/);
    expect(waybackUrl("2026", "https://a.org")).toBeNull();
  });

  test("dry runs, fixture runs and runs without keys skip archiving; each URL is captured once", async () => {
    const log = memoryLogger();
    const env = { ARCHIVE_ACCESS_KEY: "a", ARCHIVE_SECRET_KEY: "b" };
    expect(archiverFor(env, { dryRun: true, offline: false, log })).toBe(noopArchiver);
    expect(archiverFor(env, { dryRun: false, offline: true, log })).toBe(noopArchiver);
    expect(archiverFor({ ARCHIVE_ACCESS_KEY: "a" }, { dryRun: false, offline: false, log })).toBe(noopArchiver);
    expect(archiverFor(env, { dryRun: false, offline: false, log })).not.toBe(noopArchiver);
    const seen: string[] = [];
    const map = await archiveAll({ capture: (u) => (seen.push(u), Promise.resolve(u.endsWith("b") ? null : `w/${u}`)) }, ["https://a", "https://a", "https://b"]);
    expect(seen).toEqual(["https://a", "https://b"]);
    expect([...map]).toEqual([["https://a", "w/https://a"]]);
    expect(await noopArchiver.capture("x")).toBeNull();
  });
});

describe("applying changes", () => {
  const co = country("CO");

  test("sources: the quote sits on the source that holds it; merging keeps what was known", () => {
    const [s] = sourcesOf(rc(), TODAY, new Map([[SRC.url, "https://web.archive.org/web/20261026000000/x"]]));
    expect(s).toEqual({ url: SRC.url, publisher: "pasto.gov.co", accessed: TODAY, tier: "A", quote: "del 2 al 7 de enero de 2027", archive_url: "https://web.archive.org/web/20261026000000/x" });
    const merged = mergeSources([{ url: SRC.url, publisher: "Alcaldía", accessed: "2026-01-01", quote: "vieja" }], [{ url: SRC.url, publisher: "x", accessed: TODAY, tier: "A" }]);
    expect(merged).toEqual([{ url: SRC.url, publisher: "Alcaldía", accessed: TODAY, tier: "A", quote: "vieja" }]);
  });

  test("key events, confidence, status confirmations and score criteria", () => {
    const baq = (over: Partial<ReviewedChange>) => rc({ slug: "carnaval-barranquilla", ...over });
    const next = applyChanges(
      co,
      [
        baq({ field: "key_events.guacherna", old: "2027-01-29", new: "2027-01-30", confidence: "prensa" }),
        baq({ field: "status", kind: "confirmation", old: "confirmada", new: "confirmada" }),
        baq({ field: "confidence", old: "oficial", new: "prensa" }),
        baq({ field: "score.convocatoria", old: 6_000_000, new: 7_000_000, quote: "Más de 7 millones de turistas en 2027", confidence: "prensa" }),
        baq({ field: "score.calle", old: "mayoria_gratis", new: "mixta", confidence: "prensa" }),
        rc({ verdict: "flagged" }),
        rc({ country: "PE" }),
      ],
      TODAY,
    );
    const f = next.festivals.find((x) => x.slug === "carnaval-barranquilla")!;
    const e = f.editions["2027"]!;
    expect(e.key_events.find((k) => k.id === "guacherna")).toMatchObject({ date: "2027-01-30", confidence: "prensa" });
    expect(e).toMatchObject({ status: "confirmada", confidence: "prensa", sequence: 0, last_verified: TODAY });
    expect(f.score.convocatoria).toMatchObject({ measure: { attendance: 7_000_000, qualifier: "more_than", unit: "tourists", year: 2027 }, source: SRC.url });
    expect(f.score.calle).toMatchObject({ measure: "mixta", confidence: "prensa" });
    expect(next.festivals.find((x) => x.slug === "negros-y-blancos")!.editions).toEqual({});
    expect(co.festivals.find((x) => x.slug === "carnaval-barranquilla")!.editions["2027"]!.key_events[1]!.date).toBe("2027-01-29");
  });

  test("nothing to apply returns the same object; unknown festivals and invalid results throw", () => {
    expect(applyChanges(co, [rc({ verdict: "rejected" })], TODAY)).toBe(co);
    expect(() => applyChanges(co, [rc({ slug: "no-such" })], TODAY)).toThrow(/unknown festival no-such/);
    expect(() => applyChanges(co, [rc({ new: "not-a-date" })], TODAY)).toThrow(/does not validate/);
  });

  test("changelog entries only for value changes", () => {
    const entries = changelogEntries([rc(), rc({ kind: "confirmation" }), rc({ verdict: "flagged" })], TODAY);
    expect(entries).toEqual([{ date: TODAY, country: "CO", slug: "negros-y-blancos", field: "start", old: null, new: "2027-01-02", source_urls: [SRC.url] }]);
    expect(existsSync(join(REPO, "data", "usage.json"))).toBe(true);
  });
});
