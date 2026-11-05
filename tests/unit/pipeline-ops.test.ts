// Ops contract gaps: entry-point detection, RF-18 first-edition SEQUENCE, per-call RuleContext,
// the R9 news sweep and the usage fallback (R10) for runs whose PR is not merged yet.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { occurrenceFor } from "../../src/dates.ts";
import { applyFilters, buildEntries, ctxFor, occurrencesBetween } from "../../src/festivals.ts";
import { main as refreshMain } from "../../scripts/refresh.ts";
import { applyChanges, firstEditionSequence } from "../../scripts/lib/apply.ts";
import { refreshArgs, UsageError } from "../../scripts/lib/args.ts";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import { createBudgetGuard, emptyMonth, fileUsageStore, memoryUsageStore, mergeUsage, readUsageFallback, withUsageFallback, type UsageMonth } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport } from "../../scripts/lib/client.ts";
import { memoryLogger, readJson, writeJson } from "../../scripts/lib/io.ts";
import { isMainModule } from "../../scripts/lib/is-main.ts";
import { buildQueue } from "../../scripts/lib/queue.ts";
import { runRefresh } from "../../scripts/lib/refresh-run.ts";
import { buildRefreshReport, renderRefreshMarkdown } from "../../scripts/lib/report.ts";
import { config, githubOutput, readJsonFile, REFRESH_FIXTURES, refreshOptions, REPO, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";
import { accepted, edition, fest, nation, source } from "../fixtures/pipeline/synthetic.ts";

const io = { read: readJson, write: writeJson, exists: existsSync };
const month = (m: string, usd: number, over: Partial<UsageMonth> = {}): UsageMonth => ({ ...emptyMonth(m), usd, ...over });

describe("isMainModule (scripts under paths with spaces)", () => {
  test("matches the percent-encoded module URL; the old string comparison did not", () => {
    const path = "/Users/someone/My Projects/Traveler/scripts/refresh.ts";
    const url = pathToFileURL(path).href;
    expect(url).toContain("My%20Projects");
    expect(url === `file://${path}`).toBe(false);
    expect(isMainModule(url, path)).toBe(true);
    expect(isMainModule(url, "/elsewhere/refresh.ts")).toBe(false);
    expect(isMainModule(url, undefined)).toBe(false);
  });

  test("a script in a directory with spaces runs as the entry point", () => {
    const dir = mkdtempSync(join(tmpdir(), "traveler is main "));
    try {
      const probe = join(dir, "probe.ts");
      const lib = pathToFileURL(join(REPO, "scripts", "lib", "is-main.ts")).href;
      writeFileSync(probe, `import { isMainModule } from ${JSON.stringify(lib)};\nprocess.stdout.write(String(isMainModule(import.meta.url)));\n`);
      const r = spawnSync(process.execPath, [probe], { cwd: dir, encoding: "utf8", timeout: 30_000 });
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RF-18: SEQUENCE of the first stored edition", () => {
  const RULE = { type: "fixed", start: "03-01", end: "03-05" };
  const aa = (editions: Record<string, unknown> = {}) => nation("AA", [fest("AA", "fest", RULE, editions)]);
  const stored = (c: ReturnType<typeof aa>) => c.festivals[0]!.editions["2027"]!;

  test("calendars showed the rule's dates at SEQUENCE 0: new dates start the edition at 1", () => {
    const next = applyChanges(aa(), [accepted({ field: "start", new: "2027-03-02" }), accepted({ field: "end", new: "2027-03-06" })], TODAY);
    expect(stored(next)).toMatchObject({ start: "2027-03-02", end: "2027-03-06", sequence: 1 });
  });

  test("a cancellation (R9) on a festival never stored before also starts at 1", () => {
    const next = applyChanges(aa(), [accepted({ field: "status", new: "cancelada", quote: "el carnaval fue cancelado" })], TODAY);
    expect(stored(next)).toMatchObject({ status: "cancelada", sequence: 1 });
  });

  test("even when the change was classified as a confirmation, moved dates start at 1", () => {
    const changes = [accepted({ field: "start", new: "2027-03-03", kind: "confirmation" }), accepted({ field: "end", new: "2027-03-07", kind: "confirmation" })];
    expect(stored(applyChanges(aa(), changes, TODAY)).sequence).toBe(1);
  });

  test("an edition that shows the same event as the rule (confidence only) stays at 0", () => {
    const next = applyChanges(aa(), [accepted({ field: "confidence", new: "prensa" })], TODAY);
    expect(stored(next)).toMatchObject({ status: "tentativa", sequence: 0 });
    expect(next.festivals[0]!.editions["2027"]!.start).toBeUndefined();
  });

  test("an existing edition keeps its SEQUENCE on a confirmation", () => {
    const existing = edition({ start: "2027-03-01", end: "2027-03-05", status: "tentativa", sequence: 2, sources: [source("https://example.org/fest")] });
    const next = applyChanges(aa({ "2027": existing }), [accepted({ field: "start", old: "2027-03-01", new: "2027-03-01", kind: "confirmation" })], TODAY);
    expect(stored(next).sequence).toBe(2);
  });

  test("firstEditionSequence compares what calendars had with what they will get", () => {
    const f = fest("AA", "fest", RULE);
    const ctx = ctxFor(aa());
    const published = occurrenceFor(f, 2027, ctx);
    expect(firstEditionSequence(published, published)).toBe(0);
    expect(firstEditionSequence(published, { ...published!, status: "confirmada" })).toBe(1);
    expect(firstEditionSequence(published, { ...published!, end: "2027-03-06" })).toBe(1);
    expect(firstEditionSequence(published, null)).toBe(1);
    const windowOnly = occurrenceFor(fest("AA", "w", { type: "announced", window: { start: "03-01", end: "03-31" } }), 2027, ctx);
    expect(firstEditionSequence(windowOnly, published)).toBe(0);
    expect(firstEditionSequence(null, published)).toBe(0);
  });
});

describe("applyFilters builds one RuleContext per country", () => {
  // Same slugs in two countries: a context shared across countries would resolve the wrong anchor.
  const follower = { type: "relative_to", ref: "anchor", anchor: "start", offset: 10, duration_days: 2 };
  const aa = nation("AA", [fest("AA", "anchor", { type: "fixed", start: "02-01", end: "02-03" }), fest("AA", "follower", follower)]);
  const bb = nation("BB", [fest("BB", "anchor", { type: "fixed", start: "06-01", end: "06-03" }), fest("BB", "follower", follower)]);
  const byCode = new Map([aa, bb].map((c) => [c.country, c]));
  const entries = [...buildEntries(aa, config, TODAY), ...buildEntries(bb, config, TODAY)];

  test("results are identical to resolving each entry with its own country's context", () => {
    const from = TODAY;
    const to = "2027-10-26";
    const hits = applyFilters(entries, {}, TODAY);
    expect(hits).toHaveLength(4);
    for (const hit of hits) {
      const expected = occurrencesBetween(hit.entry.festival, from, to, ctxFor(byCode.get(hit.entry.country)!))[0];
      expect(hit.occurrence).toEqual(expected);
    }
    const followers = hits.filter((h) => h.entry.festival.slug === "follower").map((h) => [h.entry.country, h.occurrence.start]);
    expect(followers).toEqual([["AA", "2027-02-11"], ["BB", "2027-06-11"]]);
    expect(applyFilters(entries, { months: ["2027-06"] }, TODAY).map((h) => `${h.entry.country}/${h.entry.festival.slug}`)).toEqual(["BB/anchor", "BB/follower"]);
  });
});

describe("R9 news sweep (--sweep=news)", () => {
  test("flags: 45 days by default, --within narrows it, nothing else is accepted", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    expect(refreshArgs(["--sweep=news"], {}, now).sweepWithin).toBe(45);
    expect(refreshArgs(["--sweep=news", "--within=7"], {}, now).sweepWithin).toBe(7);
    expect("sweepWithin" in refreshArgs([], {}, now)).toBe(false);
    for (const bad of [["--within=7"], ["--sweep=all"], ["--sweep"], ["--sweep=news", "--within=0"], ["--sweep=news", "--within=46"]]) {
      expect(() => refreshArgs(bad, {}, now)).toThrow(UsageError);
    }
  });

  test("the sweep queue takes every festival starting within the window, ongoing ones included", () => {
    const aa = nation("AA", [
      fest("AA", "ongoing", { type: "fixed", start: "10-24", end: "10-30" }),
      fest("AA", "in-three", { type: "fixed", start: "10-29", end: "10-31" }),
      fest("AA", "in-twenty", { type: "fixed", start: "11-15", end: "11-16" }),
      fest("AA", "in-sixty", { type: "fixed", start: "12-25", end: "12-26" }),
    ]);
    const queue = (sweepWithin?: number) => buildQueue([aa], config, TODAY, { max: 40, perCountry: 10, ...(sweepWithin ? { sweepWithin } : {}) });
    expect(queue(45).map((i) => [i.slug, i.reasons])).toEqual([["ongoing", ["news"]], ["in-three", ["news"]], ["in-twenty", ["news"]]]);
    expect(queue(7).map((i) => i.slug)).toEqual(["ongoing", "in-three"]);
    expect(queue().map((i) => i.slug)).toContain("in-sixty");
  });

  test("a sweep run over CO verifies only what starts within the window and never carries the trap", async () => {
    const root = tempRepo({ countries: ["co"] });
    const out = join(root, "gh");
    writeFileSync(out, "");
    const deps = () => ({ transport: fixtureDirTransport(REFRESH_FIXTURES), archiver: noopArchiver, usage: memoryUsageStore(), log: memoryLogger() });
    const run = await runRefresh(refreshOptions(root, { sweepWithin: 45, trapSecret: "test-secret", githubOutput: out }), deps());
    const r = run.report!;
    expect(r.sweep_within).toBe(45);
    // Structural only: which CO festivals fall in the window depends on data other changes edit.
    expect(r.festivals.length).toBeGreaterThan(0);
    expect(r.festivals.every((f) => f.reasons.join() === "news" && f.days_to_start !== null && f.days_to_start <= 45)).toBe(true);
    expect(githubOutput(out).trap_fingerprint).toBeUndefined();
    const lastWeek = await runRefresh(refreshOptions(root, { sweepWithin: 7 }), deps());
    expect(lastWeek.report!.festivals.every((f) => f.days_to_start !== null && f.days_to_start <= 7)).toBe(true);
  });

  test("the sweep report says so in its heading", () => {
    const base = { date: TODAY, model: "m", dry_run: true, stopped: null, budget: { month: "2026-10", usd: 0, budget_usd: 20, level: "ok" as const, searches: 0 }, festivals: [], not_found: [] };
    const empty = { applied: [], confirmations: [], flagged: [], rejected: [], deferred: [] };
    expect(renderRefreshMarkdown(buildRefreshReport({ ...base, sweep_within: 45 }, empty))).toContain("## Barrido de noticias 2026-10-26 (fiestas a 45 días o menos)");
    expect(renderRefreshMarkdown(buildRefreshReport(base, empty))).toContain("## Verificación semanal 2026-10-26");
  });

  test("sweeps and onboarding spend from the budget without using up the month's weekly run (R12)", () => {
    const store = memoryUsageStore();
    const call = { searches: 1, input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const ctx = { key: "AA/x", kind: "research" as const };
    const sweep = createBudgetGuard({ month: "2026-11", budgetUsd: 20, model: "m", store, log: memoryLogger(), weekly: false });
    expect(sweep.firstRunOfMonth).toBe(false);
    sweep.afterCall(ctx, call);
    expect(store.saved.at(-1)![0]).toMatchObject({ month: "2026-11", weekly_runs: 0 });
    const weekly = createBudgetGuard({ month: "2026-11", budgetUsd: 20, model: "m", store, log: memoryLogger() });
    expect(weekly.firstRunOfMonth).toBe(true);
    weekly.afterCall(ctx, call);
    expect(store.saved.at(-1)![0]).toMatchObject({ weekly_runs: 1, searches: 2 });
    expect(createBudgetGuard({ month: "2026-11", budgetUsd: 20, model: "m", store, log: memoryLogger() }).firstRunOfMonth).toBe(false);
  });
});

describe("R10 usage fallback (USAGE_FALLBACK_PATH)", () => {
  test("per month the higher running total wins", () => {
    const main = [month("2026-09", 5), month("2026-10", 3)];
    const artifact = [month("2026-10", 7, { searches: 4 }), month("2026-11", 1)];
    expect(mergeUsage(main, artifact)).toEqual([month("2026-09", 5), month("2026-10", 7, { searches: 4 }), month("2026-11", 1)]);
    expect(mergeUsage([month("2026-10", 9)], [month("2026-10", 2)])).toEqual([month("2026-10", 9)]);
  });

  test("unset, missing or broken fallback files are ignored with a log line", () => {
    const root = tempRepo({ countries: [] });
    const log = memoryLogger();
    expect(readUsageFallback(undefined, io, log)).toEqual([]);
    expect(readUsageFallback(join(root, "nope.json"), io, log)).toEqual([]);
    writeFileSync(join(root, "bad.json"), "{not json");
    expect(readUsageFallback(join(root, "bad.json"), io, log)).toEqual([]);
    writeFileSync(join(root, "wrong.json"), JSON.stringify([{ month: "2026-10" }]));
    expect(readUsageFallback(join(root, "wrong.json"), io, log)).toEqual([]);
    writeFileSync(join(root, "ok.json"), JSON.stringify([month("2026-10", 4)]));
    expect(readUsageFallback(join(root, "ok.json"), io, log)).toEqual([month("2026-10", 4)]);
    expect(log.lines.filter((l) => l.startsWith("warning: R10")).length).toBe(2);
  });

  test("online, the merged total is written to data/usage.json at once, so the uploaded artifact never goes back", () => {
    const root = tempRepo({ countries: [] });
    const path = join(root, "data", "usage.json");
    writeJson(path, [month("2026-10", 3)]);
    const store = withUsageFallback(fileUsageStore(path, io), [month("2026-10", 8)], { persist: true, log: memoryLogger() });
    expect(readJsonFile(path)).toEqual([month("2026-10", 8)]);
    expect(store.load()).toEqual([month("2026-10", 8)]);
    writeJson(path, [month("2026-10", 12)]);
    withUsageFallback(fileUsageStore(path, io), [month("2026-10", 8)], { persist: true, log: memoryLogger() });
    expect(readJsonFile(path)).toEqual([month("2026-10", 12)]);
  });

  test("pnpm refresh reads the fallback: 97% of the budget in the last artifact degrades the run (R10)", async () => {
    const root = tempRepo({ countries: ["co"] });
    const fallback = join(root, "usage-prev.json");
    writeFileSync(fallback, JSON.stringify([month("2026-10", 19.5)]));
    const log = memoryLogger();
    const code = await refreshMain(["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], { USAGE_FALLBACK_PATH: fallback }, root, log);
    expect(code).toBe(0);
    expect(log.lines).toContain("warning: R10: 98% of MONTHLY_BUDGET_USD used (US$19.50 of US$20)");
    expect(log.lines.some((l) => l.includes("only tier-1 festivals starting within 60 days"))).toBe(true);
    // Offline runs still never write data/usage.json.
    expect(readFileSync(join(root, "data", "usage.json"), "utf8")).toBe("[]\n");
  });

  test("a fallback below data/usage.json loses to it", async () => {
    const root = tempRepo({ countries: ["co"] });
    writeFileSync(join(root, "data", "usage.json"), JSON.stringify([month("2026-10", 19.5)]));
    writeFileSync(join(root, "usage-prev.json"), JSON.stringify([month("2026-10", 1)]));
    const log = memoryLogger();
    await refreshMain(["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], { USAGE_FALLBACK_PATH: join(root, "usage-prev.json") }, root, log);
    expect(log.lines).toContain("warning: R10: 98% of MONTHLY_BUDGET_USD used (US$19.50 of US$20)");
  });

  test("a fallback over the cap stops the run before any call", async () => {
    const root = tempRepo({ countries: ["co"] });
    const dir = join(root, "prev");
    mkdirSync(dir);
    writeFileSync(join(dir, "usage.json"), JSON.stringify([month("2026-10", 25)]));
    const log = memoryLogger();
    const code = await refreshMain(["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], { USAGE_FALLBACK_PATH: join(dir, "usage.json") }, root, log);
    expect(code).toBe(1);
    expect(log.lines.join("\n")).toMatch(/monthly budget reached/);
  });
});
