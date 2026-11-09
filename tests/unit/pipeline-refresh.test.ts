import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { ChangelogEntry, CountryFile } from "../../src/schema.ts";
import { main as refreshMain } from "../../scripts/refresh.ts";
import { onboardArgs, parseFlags, refreshArgs, UsageError } from "../../scripts/lib/args.ts";
import { noopArchiver, type Archiver } from "../../scripts/lib/archive.ts";
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport, replayTransport, type MessagesTransport } from "../../scripts/lib/client.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { buildQueue, compareItems, monthlySlot, reasonsFor } from "../../scripts/lib/queue.ts";
import { runRefresh, type RefreshDeps } from "../../scripts/lib/refresh-run.ts";
import { dataChangeCount, selectForApply } from "../../scripts/lib/select.ts";
import type { ReviewedChange } from "../../scripts/lib/validate.ts";
import { config, countries, country, githubOutput, json, message, readJsonFile, REFRESH_FIXTURES, refreshOptions, REPO, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";
import type { RefreshReport } from "../../scripts/lib/report.ts";

const deps = (over: Partial<RefreshDeps> = {}): RefreshDeps => ({
  transport: fixtureDirTransport(REFRESH_FIXTURES),
  archiver: noopArchiver,
  usage: memoryUsageStore(),
  log: memoryLogger(),
  ...over,
});

const find = (list: readonly ReviewedChange[], slug: string, field: string) => list.find((c) => c.slug === slug && c.field === field);
const coFile = (root: string) => CountryFile.parse(readJsonFile(join(root, "data", "countries", "co.json")));
const edition = (root: string, slug: string, year: string) => coFile(root).festivals.find((f) => f.slug === slug)!.editions[year];
/**
 * The recorded responses were captured against the PRD-era CO file, so the H4 scenarios replay
 * against that frozen copy. Its confirmed editions were verified on TODAY, which the R10 cadence
 * would skip; dated three weeks back they are stale and verified again, as the scenarios need.
 */
const prdRepo = (): string => {
  const root = tempRepo();
  const file = CountryFile.parse(readJsonFile(join(REPO, "tests", "fixtures", "prd", "co.json")));
  const aged = {
    ...file,
    festivals: file.festivals.map((f) => ({
      ...f,
      editions: Object.fromEntries(Object.entries(f.editions).map(([y, e]) => [y, e.last_verified ? { ...e, last_verified: "2026-10-05" } : e])),
    })),
  };
  writeFileSync(join(root, "data", "countries", "co.json"), `${JSON.stringify(aged, null, 2)}\n`);
  return root;
};

describe("refresh with recorded responses (H4 acceptance)", () => {
  test("--dry-run: each recorded scenario ends where the PRD says, and only proposals are written", async () => {
    const root = prdRepo();
    const before = readFileSync(join(root, "data", "countries", "co.json"), "utf8");
    const out = join(root, "gh");
    writeFileSync(out, "");
    const result = await runRefresh(refreshOptions(root, { githubOutput: out }), deps());
    const r = result.report!;

    // Matching citation and verbatim quote: accepted.
    expect(find(r.applied, "negros-y-blancos", "start")).toMatchObject({ new: "2027-01-02", confidence: "oficial", verdict: "accepted" });
    // No source among the citations: rejected.
    expect(find(r.rejected, "feria-de-cali", "end")!.reasons.join()).toMatch(/sin fuente/);
    // Outside the rule window: flagged «revisar», never applied.
    expect(find(r.flagged, "festival-vallenato", "start")!.flags.join()).toMatch(/^revisar: fuera de la ventana/);
    // Injection phrase in the cited text: flagged.
    expect(find(r.flagged, "san-pacho", "status")!.flags.join()).toMatch(/inyección/);
    // Press-only domain claiming «oficial»: downgraded.
    expect(find(r.applied, "independencia-cartagena", "start")).toMatchObject({ proposed_confidence: "oficial", confidence: "prensa" });
    // pause_turn resumed, then the official site confirmed the stored dates.
    expect(find(r.confirmations, "carnaval-barranquilla", "start")).toMatchObject({ kind: "confirmation", new: "2027-02-06" });

    const log = (slug: string) => r.festivals.find((f) => f.slug === slug)!;
    expect(log("carnaval-riosucio").outcome).toBe("refusal");
    expect(log("san-pacho")).toMatchObject({ pass: 2, search_errors: ["unavailable"] });
    expect(log("feria-de-cali").pass).toBe(2);
    expect(log("petronio-alvarez").outcome).toBe("no_fixture");
    expect(r.not_found).toContainEqual({ country: "CO", slug: "negros-y-blancos", fields: ["score.convocatoria"] });

    expect(result.files.map((f) => f.slice(root.length + 1)).sort()).toEqual(["proposals/2026-10-26.json", "proposals/2026-10-26.md"]);
    expect(readFileSync(join(root, "data", "countries", "co.json"), "utf8")).toBe(before);
    expect(githubOutput(out)).toEqual({ changes: String(r.applied.length + r.confirmations.length), flagged: "4", unexpected: "0", verified: String(r.festivals.filter((f) => !["api_error", "error", "no_fixture", "skipped_budget", "not_run"].includes(f.outcome)).length) });

    const md = readFileSync(join(root, "proposals", "2026-10-26.md"), "utf8");
    expect(md).toContain(`### Cambios aplicados (${r.applied.length})`);
    expect(md).toContain("**Nivel 1**");
    expect(md).toContain("### Retenidos, no aplicados (4)");
    expect(md).toContain("Rechazados por la validación (1)");
    expect(md).not.toMatch(/<script|@\w/);
  });

  test("without --dry-run: accepted changes are applied immutably, flagged and rejected ones are not", async () => {
    const root = prdRepo();
    const archived: string[] = [];
    const archiver: Archiver = { capture: (url) => (archived.push(url), Promise.resolve(`https://web.archive.org/web/20261026000000/${url}`)) };
    const changelogBefore = readJsonFile<unknown[]>(join(root, "data", "changelog.json")).length;
    const result = await runRefresh(refreshOptions(root, { dryRun: false }), deps({ archiver }));
    expect(result.exitCode).toBe(0);

    const nyb = edition(root, "negros-y-blancos", "2027")!;
    expect(nyb).toMatchObject({ start: "2027-01-02", end: "2027-01-07", status: "confirmada", confidence: "oficial", last_verified: TODAY, sequence: 1 });
    expect(nyb.sources[0]).toMatchObject({ tier: "A", accessed: TODAY, quote: expect.stringContaining("de enero de 2027") as unknown, archive_url: expect.stringMatching(/^https:\/\/web\.archive\.org\/web\/\d{14}\//) as unknown });
    expect(edition(root, "independencia-cartagena", "2026")).toMatchObject({ start: "2026-11-10", end: "2026-11-16", confidence: "prensa", sequence: 1 });
    expect(edition(root, "festival-vallenato", "2027")).toBeUndefined();
    expect(edition(root, "san-pacho", "2027")).toBeUndefined();
    expect(edition(root, "feria-de-cali", "2026")).toMatchObject({ end: "2026-12-30", sequence: 0, last_verified: TODAY });
    const baq = edition(root, "carnaval-barranquilla", "2027")!;
    expect(baq).toMatchObject({ start: "2027-02-06", end: "2027-02-09", sequence: 0, last_verified: TODAY });
    expect(baq.key_events).toHaveLength(3);
    expect(coFile(root).generated_at).toBe(TODAY);
    expect(coFile(root).festivals).toHaveLength(10);
    expect(new Set(archived).size).toBe(archived.length);

    const changelog = ChangelogEntry.array().parse(readJsonFile(join(root, "data", "changelog.json")));
    expect(changelog.length - changelogBefore).toBe(5);
    expect(changelog.slice(changelogBefore).map((e) => `${e.slug}.${e.field}`).sort()).toEqual([
      "independencia-cartagena.end",
      "independencia-cartagena.start",
      "negros-y-blancos.end",
      "negros-y-blancos.start",
      "negros-y-blancos.status",
    ]);
    expect(result.files.map((f) => f.slice(root.length + 1)).sort()).toEqual(["data/changelog.json", "data/countries/co.json", "proposals/2026-10-26.json", "proposals/2026-10-26.md"]);
  });

  test("no changes: only the report is written (for the run artifact) and changes=0", async () => {
    const root = tempRepo();
    const out = join(root, "gh");
    writeFileSync(out, "");
    const before = readFileSync(join(root, "data", "countries", "co.json"), "utf8");
    const result = await runRefresh(refreshOptions(root, { dryRun: false, only: "carnaval-riosucio", githubOutput: out }), deps());
    expect(result.files.map((f) => f.slice(root.length + 1)).sort()).toEqual(["proposals/2026-10-26.json", "proposals/2026-10-26.md"]);
    expect(readJsonFile<RefreshReport>(join(root, "proposals", `${TODAY}.json`)).festivals[0]).toMatchObject({ slug: "carnaval-riosucio", outcome: "refusal" });
    expect(readFileSync(join(root, "data", "countries", "co.json"), "utf8")).toBe(before);
    expect(githubOutput(out)).toMatchObject({ changes: "0", flagged: "0" });
  });

  test("--only must name a festival", async () => {
    const log = memoryLogger();
    expect((await runRefresh(refreshOptions(tempRepo(), { only: "no-such-fiesta" }), deps({ log }))).exitCode).toBe(1);
    expect(log.lines.join()).toMatch(/no festival with that slug/);
  });

  test("API errors: rate limits are logged and the run goes on; rejected credentials stop it", async () => {
    const headers = new Headers();
    const failing = (error: Error): MessagesTransport => ({ create: () => Promise.reject(error) });
    const limited = await runRefresh(refreshOptions(tempRepo(), { maxFestivals: 2 }), deps({ transport: failing(new Anthropic.RateLimitError(429, undefined, "slow down", headers)) }));
    expect(limited.exitCode).toBe(0);
    expect(limited.report!.festivals.map((f) => f.outcome)).toEqual(["api_error", "api_error"]);
    const denied = await runRefresh(refreshOptions(tempRepo(), { maxFestivals: 3 }), deps({ transport: failing(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", headers)) }));
    expect(denied.exitCode).toBe(1);
    expect(denied.report!.stopped).toMatch(/credentials rejected/);
    expect(denied.report!.festivals.map((f) => f.outcome)).toEqual(["api_error", "not_run", "not_run"]);
    // code-F2: an unexpected error in one festival is logged and the others still run; BE-04: when
    // nothing was verified at all the run goes red, and the error detail still reaches proposals/.
    const root = tempRepo();
    const out = join(root, "gh");
    writeFileSync(out, "");
    const log = memoryLogger();
    const buggy = await runRefresh(refreshOptions(root, { maxFestivals: 2, githubOutput: out }), deps({ transport: failing(new TypeError("bug\n::warning::x")), log }));
    expect(buggy.exitCode).toBe(1);
    expect(buggy.report!.festivals.map((f) => [f.outcome, f.detail])).toEqual([["error", "bug\n::warning::x"], ["error", "bug\n::warning::x"]]);
    expect(githubOutput(out)).toMatchObject({ changes: "0", unexpected: "2", verified: "0" });
    expect(existsSync(join(root, "proposals", `${TODAY}.json`))).toBe(true);
    // One workflow annotation per failure, on one line, so the message cannot inject commands.
    expect(log.lines.filter((l) => l.startsWith("::error::"))).toHaveLength(2);
    expect(log.lines.find((l) => l.startsWith("::error::"))).toMatch(/^::error::[A-Z]{2}\/[a-z0-9-]+: unexpected error: bug%0A::warning::x$/);
  });

  test("one festival with an unexpected error does not fail a run that verified others (BE-04)", async () => {
    const root = prdRepo();
    const out = join(root, "gh");
    writeFileSync(out, "");
    const recorded = fixtureDirTransport(REFRESH_FIXTURES);
    let first: string | null = null;
    const flaky: MessagesTransport = {
      create: (params, ctx) => {
        first ??= ctx.key;
        return ctx.key === first ? Promise.reject(new TypeError("bug")) : recorded.create(params, ctx);
      },
    };
    const result = await runRefresh(refreshOptions(root, { githubOutput: out }), deps({ transport: flaky }));
    expect(result.exitCode).toBe(0);
    expect(result.report!.festivals.filter((f) => f.outcome === "error")).toHaveLength(1);
    const gh = githubOutput(out);
    expect(gh.unexpected).toBe("1");
    expect(Number(gh.verified)).toBeGreaterThan(0);
    expect(existsSync(join(root, "proposals", `${TODAY}.json`))).toBe(true);
  });

  test("a proposal that never validates, or is about another festival, is dropped with a log line", async () => {
    const research = fixtureDirTransport(REFRESH_FIXTURES);
    const cited = await research.create({ model: "m", max_tokens: 1, messages: [] }, { key: "CO/negros-y-blancos", kind: "research" });
    const bad = replayTransport({ "CO/negros-y-blancos": { research: [cited], extract: [json({ nope: 1 }), json({ nope: 2 })] } });
    const r1 = await runRefresh(refreshOptions(tempRepo(), { only: "negros-y-blancos" }), deps({ transport: bad }));
    expect(r1.report!.festivals[0]).toMatchObject({ outcome: "invalid_proposal" });
    const other = replayTransport({ "CO/negros-y-blancos": { research: [cited], extract: [json({ country: "CO", slug: "feria-de-cali", edition: 2027, changes: [], not_found: [] })] } });
    const r2 = await runRefresh(refreshOptions(tempRepo(), { only: "negros-y-blancos" }), deps({ transport: other }));
    expect(r2.report!.festivals[0]!.detail).toMatch(/otra fiesta/);
    const refused = replayTransport({ "CO/negros-y-blancos": { research: [cited], extract: [message([], "refusal")] } });
    const r3 = await runRefresh(refreshOptions(tempRepo(), { only: "negros-y-blancos" }), deps({ transport: refused }));
    expect(r3.report!.festivals[0]!.outcome).toBe("refusal");
  });
});

describe("queue", () => {
  test("R10 cadence: unconfirmed weekly from 180 days and monthly before; confirmed when stale (30 days, 14 under 120)", () => {
    expect(reasonsFor(100, "tentativa", TODAY, TODAY)).toEqual(["soon", "unconfirmed"]);
    expect(reasonsFor(-20, "aplazada", null, TODAY)).toEqual(["soon", "unconfirmed"]);
    // Far and unconfirmed: only in the first week of the month.
    expect(reasonsFor(200, "tentativa", null, TODAY)).toEqual([]);
    expect(reasonsFor(200, "tentativa", null, "2026-11-07")).toEqual(["unconfirmed"]);
    expect(reasonsFor(Number.POSITIVE_INFINITY, "por_anunciar", null, "2026-11-02")).toEqual(["unconfirmed"]);
    expect(reasonsFor(Number.POSITIVE_INFINITY, "por_anunciar", null, "2026-11-08")).toEqual([]);
    expect(monthlySlot("2026-11-07")).toBe(true);
    expect(monthlySlot("2026-11-08")).toBe(false);
    // Confirmed: being soon is not enough; the news sweeps watch the last 45 days.
    expect(reasonsFor(100, "confirmada", TODAY, TODAY)).toEqual([]);
    expect(reasonsFor(100, "confirmada", "2026-10-12", TODAY)).toEqual([]);
    expect(reasonsFor(100, "confirmada", "2026-10-11", TODAY)).toEqual(["stale"]);
    expect(reasonsFor(200, "confirmada", "2026-09-26", TODAY)).toEqual([]);
    expect(reasonsFor(200, "confirmada", "2026-09-25", TODAY)).toEqual(["stale"]);
    expect(reasonsFor(200, "confirmada", null, TODAY)).toEqual(["stale"]);
  });

  test("a run for one country (manual dispatch) always gets the monthly checks", () => {
    const br = country("BR");
    const scheduled = buildQueue([br], config, "2026-11-09", { max: 40, perCountry: 10 }).map((i) => i.slug);
    const manual = buildQueue([br], config, "2026-11-09", { max: 40, perCountry: 10, country: "BR" }).map((i) => i.slug);
    expect(scheduled).not.toContain("cirio-de-nazare");
    expect(manual).toContain("cirio-de-nazare");
    expect(buildQueue([br], config, "2026-12-07", { max: 40, perCountry: 10 }).map((i) => i.slug)).toContain("cirio-de-nazare");
  });

  // src/status.ts: a cancellation is settled like a confirmation, and has nothing left to sweep for.
  test("a cancelled edition is re-verified only when stale and never swept", () => {
    expect(reasonsFor(100, "cancelada", TODAY, TODAY)).toEqual([]);
    expect(reasonsFor(100, "cancelada", "2026-10-11", TODAY)).toEqual(["stale"]);
    expect(reasonsFor(200, "cancelada", null, "2026-11-07")).toEqual(["stale"]);

    const co = country("CO");
    const sweep = (c: CountryFile) => buildQueue([c], config, TODAY, { max: 40, perCountry: 10, sweepWithin: 45 }).map((i) => i.slug);
    expect(sweep(co)).toContain("independencia-cartagena");
    const source = { url: "https://www.cartagena.gov.co/", publisher: "Alcaldía de Cartagena", accessed: TODAY, tier: "A" as const };
    const cancelled = CountryFile.parse({
      ...co,
      festivals: co.festivals.map((f) => (f.slug === "independencia-cartagena" ? { ...f, editions: { ...f.editions, "2026": { status: "cancelada", confidence: "oficial", sources: [source], last_verified: TODAY, sequence: 1 } } } : f)),
    });
    expect(sweep(cancelled)).not.toContain("independencia-cartagena");
    expect(buildQueue([cancelled], config, TODAY, { max: 40, perCountry: 10 }).map((i) => i.slug)).not.toContain("independencia-cartagena");
  });

  test("a postponed edition without new dates stays in the weekly run but out of the news sweeps", () => {
    const co = country("CO");
    const sweep = buildQueue([co], config, TODAY, { max: 40, perCountry: 10, sweepWithin: 45 }).map((i) => i.slug);
    expect(sweep).not.toContain("petronio-alvarez");
    expect(sweep).toContain("independencia-cartagena");
    expect(buildQueue([co], config, TODAY, { max: 40, perCountry: 10 }).find((i) => i.slug === "petronio-alvarez")?.reasons).toEqual(["soon", "unconfirmed"]);
  });

  test("ordered by days to start then tier, capped overall and per country", () => {
    const all = buildQueue(countries(), config, TODAY, { max: 40, perCountry: 10 });
    const days = all.map((i) => i.daysToStart);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(buildQueue(countries(), config, TODAY, { max: 3, perCountry: 10 })).toHaveLength(3);
    const perCountry = buildQueue(countries(), config, TODAY, { max: 40, perCountry: 2 });
    expect(Math.max(...["CO", "PE", "BO"].map((cc) => perCountry.filter((i) => i.country === cc).length))).toBe(2);
    expect(buildQueue(countries(), config, TODAY, { max: 40, perCountry: 10, country: "co" }).every((i) => i.country === "CO")).toBe(true);
    const a = all[0]!;
    expect(compareItems(a, { ...a, tier: "provisional" })).toBeLessThanOrEqual(0);
  });

  test("--only forces a festival in even when no rule queues it", () => {
    // In July the 2027 edition is confirmed, more than 180 days out and freshly verified.
    expect(buildQueue(countries(), config, "2026-07-01", { max: 40, perCountry: 10 }).some((i) => i.slug === "carnaval-barranquilla")).toBe(false);
    const forced = buildQueue(countries(), config, "2026-07-01", { max: 40, perCountry: 10, only: "carnaval-barranquilla" });
    expect(forced.map((i) => [i.slug, i.year, i.reasons])).toEqual([["carnaval-barranquilla", 2027, ["manual"]]]);
  });
});

describe("auto-approval selection", () => {
  const base = (i: number, over: Partial<ReviewedChange> = {}): ReviewedChange =>
    ({ country: "CO", slug: `f${String(i).padStart(2, "0")}`, name: "F", tier: 2, year: 2027, daysToStart: i, field: "start", old: null, new: "2027-01-01", kind: "change", sources: [], quote_url: null, quote: "", quote_language: "es", proposed_confidence: "prensa", confidence: "prensa", note: "", verdict: "accepted", flags: [], reasons: [], adjustments: [], risk: 70, ...over }) as ReviewedChange;

  test("every accepted change is applied, riskiest first, with no cap; flagged ones are held", () => {
    const all = [...Array.from({ length: 18 }, (_, i) => base(i)), base(30, { tier: 1, risk: 100 }), base(31, { kind: "confirmation" }), base(32, { verdict: "rejected" }), base(33, { verdict: "flagged" })];
    const s = selectForApply(all);
    expect(s.applied).toHaveLength(19);
    expect(s.applied[0]!.slug).toBe("f30");
    expect(s.confirmations).toHaveLength(1);
    expect(s.rejected).toHaveLength(1);
    expect(s.flagged.map((c) => c.slug)).toEqual(["f33"]);
    expect(dataChangeCount(s)).toBe(20);
  });

  test("a confirmation of a field the same run changes is dropped, so apply cannot undo the change", () => {
    const s = selectForApply([base(1, { new: "2027-01-02" }), base(1, { kind: "confirmation", new: "2027-01-01" })]);
    expect(s.applied).toHaveLength(1);
    expect(s.confirmations).toHaveLength(0);
  });
});

describe("CLI (docs/architecture.md «Pipeline CLI»)", () => {
  test("flags and env vars", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    expect(refreshArgs(["--", "--dry-run", "--only=feria-de-cali", "--country=co"], { MAX_FESTIVALS_PER_RUN: "12", MONTHLY_BUDGET_USD: "7.5", GITHUB_OUTPUT: "/tmp/o" }, now)).toEqual({
      dryRun: true,
      today: "2026-10-26",
      fixtures: null,
      model: "claude-sonnet-5-5",
      budgetUsd: 7.5,
      githubOutput: "/tmp/o",
      only: "feria-de-cali",
      country: "CO",
      maxFestivals: 12,
      perCountry: 10,
      maxFollowups: 6,
    });
    expect(refreshArgs([], { MAX_FOLLOWUPS_PER_RUN: "0" }, now).maxFollowups).toBe(0);
    expect(() => refreshArgs([], { MAX_FOLLOWUPS_PER_RUN: "-1" }, now)).toThrow(/0 or a positive integer/);
    expect(onboardArgs(["--country=pe", "--today=2026-11-01"], {}, now)).toMatchObject({ country: "PE", today: "2026-11-01", dryRun: false });
    for (const bad of [["--today=26/10/2026"], ["--only=Bad Slug"], ["--country=COL"], ["--x"], ["--only"]]) expect(() => refreshArgs(bad, {}, now)).toThrow(UsageError);
    expect(() => refreshArgs([], { MAX_FESTIVALS_PER_RUN: "0" }, now)).toThrow(/positive integer/);
    expect(() => refreshArgs([], { MONTHLY_BUDGET_USD: "-1" }, now)).toThrow(/positive number/);
    expect(() => onboardArgs([], {}, now)).toThrow(/--country=<cc> is required/);
    expect(parseFlags(["--verbose"]).get("verbose")).toBe(true);
  });

  test("pnpm refresh -- --fixtures runs offline and never writes the ledger", async () => {
    const root = tempRepo();
    const log = memoryLogger();
    const code = await refreshMain(["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], {}, root, log);
    expect(code).toBe(0);
    expect(existsSync(join(root, "data", "state", "ledger.jsonl"))).toBe(false);
    expect(log.lines.filter((l) => l.startsWith("wrote "))).toHaveLength(2);
    const report = readJsonFile<RefreshReport>(join(root, "proposals", `${TODAY}.json`));
    expect(report.kind).toBe("refresh");
    expect(await refreshMain(["--nope"], {}, root, memoryLogger())).toBe(2);
  });
});
