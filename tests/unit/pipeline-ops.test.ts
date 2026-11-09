// Ops contract gaps: entry-point detection, RF-18 first-edition SEQUENCE, per-call RuleContext,
// the R9 news sweep and the spend ledger (R10) the CLIs read before the first call.
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
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport } from "../../scripts/lib/client.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { isMainModule } from "../../scripts/lib/is-main.ts";
import { buildQueue } from "../../scripts/lib/queue.ts";
import { runRefresh } from "../../scripts/lib/refresh-run.ts";
import { buildRefreshReport, renderRefreshMarkdown } from "../../scripts/lib/report.ts";
import { config, REFRESH_FIXTURES, refreshOptions, REPO, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";
import { accepted, edition, fest, nation, source } from "../fixtures/pipeline/synthetic.ts";

/** One carry-over line worth `usd` in the temp repo's ledger. */
function ledgerWith(root: string, usd: number, day = TODAY): void {
  mkdirSync(join(root, "data", "state"), { recursive: true });
  const line = { day, job: "verify", key: `carryover/${day.slice(0, 7)}`, call: "carryover", model: "m", searches: 0, input_tokens: 0, output_tokens: 0, usd };
  writeFileSync(join(root, "data", "state", "ledger.jsonl"), `${JSON.stringify(line)}\n`);
}

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

  test("a sweep run over CO verifies only what starts within the window and records its calls as sweeps", async () => {
    const root = tempRepo({ countries: ["co"] });
    const usage = memoryUsageStore();
    const deps = () => ({ transport: fixtureDirTransport(REFRESH_FIXTURES), archiver: noopArchiver, usage, log: memoryLogger() });
    const run = await runRefresh(refreshOptions(root, { sweepWithin: 45 }), deps());
    const r = run.report!;
    expect(r.sweep_within).toBe(45);
    // Structural only: which CO festivals fall in the window depends on data other changes edit.
    expect(r.festivals.length).toBeGreaterThan(0);
    expect(r.festivals.every((f) => f.reasons.join() === "news" && f.days_to_start !== null && f.days_to_start <= 45)).toBe(true);
    expect(usage.entries.every((e) => e.job === "sweep" && e.day === TODAY)).toBe(true);
    const lastWeek = await runRefresh(refreshOptions(root, { sweepWithin: 7 }), deps());
    expect(lastWeek.report!.festivals.every((f) => f.days_to_start !== null && f.days_to_start <= 7)).toBe(true);
  });

  test("the sweep report says so in its heading", () => {
    const base = { date: TODAY, model: "m", dry_run: true, stopped: null, budget: { month: "2026-10", usd: 0, budget_usd: 20, level: "ok" as const, searches: 0 }, festivals: [], not_found: [] };
    const empty = { applied: [], confirmations: [], flagged: [], rejected: [] };
    expect(renderRefreshMarkdown(buildRefreshReport({ ...base, sweep_within: 45 }, empty))).toContain("## Barrido de noticias 2026-10-26 (fiestas a 45 días o menos)");
    expect(renderRefreshMarkdown(buildRefreshReport(base, empty))).toContain("## Verificación 2026-10-26");
  });
});

describe("R10: the CLIs read the ledger before the first call", () => {
  test("97% of the budget on record degrades the run to tier-1 festivals within 60 days", async () => {
    const root = tempRepo({ countries: ["co"] });
    ledgerWith(root, 19.5);
    const log = memoryLogger();
    const code = await refreshMain(["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], {}, root, log);
    expect(code).toBe(0);
    expect(log.lines).toContain("warning: R10: 98% of MONTHLY_BUDGET_USD used (US$19.50 of US$20)");
    expect(log.lines.some((l) => l.includes("only tier-1 festivals starting within 60 days"))).toBe(true);
    // Offline runs never append to the ledger.
    expect(readFileSync(join(root, "data", "state", "ledger.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("last month's spend does not count against this month", async () => {
    const root = tempRepo({ countries: ["co"] });
    ledgerWith(root, 19.5, "2026-09-30");
    const log = memoryLogger();
    await refreshMain(["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], {}, root, log);
    expect(log.lines.some((l) => l.includes("R10:"))).toBe(false);
  });

  test("a ledger over the cap stops the run before any call", async () => {
    const root = tempRepo({ countries: ["co"] });
    ledgerWith(root, 25);
    const log = memoryLogger();
    const code = await refreshMain(["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], {}, root, log);
    expect(code).toBe(1);
    expect(log.lines.join("\n")).toMatch(/monthly budget reached/);
  });
});
