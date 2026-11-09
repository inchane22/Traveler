import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import {
  addUsage,
  allowedAtLevel,
  BudgetExceededError,
  costOf,
  createBudgetGuard,
  emptyMonth,
  ledgerUsageStore,
  levelOf,
  memoryUsageStore,
  priceFor,
} from "../../scripts/lib/budget.ts";
import { fixtureDirTransport } from "../../scripts/lib/client.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import { averageJobCost, lastDays, parseLedger, readLedger, spendByPool, type LedgerEntry } from "../../scripts/lib/ledger.ts";
import { runRefresh } from "../../scripts/lib/refresh-run.ts";
import { githubOutput, REFRESH_FIXTURES, refreshOptions, tempRepo } from "../fixtures/pipeline/helpers.ts";

const call = { searches: 1, input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const ctx = { key: "CO/x", kind: "research" as const };

describe("cost model (R10)", () => {
  test("searches at US$0.01 plus tokens at the model's price, cache writes 1.25x and reads 0.1x", () => {
    expect(costOf(call, "claude-sonnet-5-5")).toBeCloseTo(0.01 + 2 + 1, 6);
    expect(costOf({ ...call, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }, "claude-sonnet-5-5")).toBeCloseTo(0.01 + 2.5 + 0.2, 6);
    expect(priceFor("some-new-model")).toEqual({ input: 4, output: 20 });
    expect(addUsage(emptyMonth("2026-10"), { ...call, cache_read_input_tokens: 10 }, "claude-sonnet-5-5")).toMatchObject({ searches: 1, input_tokens: 1_000_010, output_tokens: 100_000 });
  });

  test("levels and the 80% degradation rule", () => {
    expect([levelOf(0, 20), levelOf(10, 20), levelOf(16, 20), levelOf(20, 20), levelOf(1, 0)]).toEqual(["ok", "warn50", "degraded80", "stopped", "stopped"]);
    expect(allowedAtLevel("degraded80", 1, 60)).toBe(true);
    expect(allowedAtLevel("degraded80", 1, 61)).toBe(false);
    expect(allowedAtLevel("degraded80", 2, 10)).toBe(false);
    expect(allowedAtLevel("warn50", "provisional", 300)).toBe(true);
    expect(allowedAtLevel("stopped", 1, 1)).toBe(false);
  });
});

describe("budget guard", () => {
  test("warns once at 50% and at 80%, throws before the call at 100%, persists after each call", () => {
    const store = memoryUsageStore([{ month: "2026-09", searches: 9, input_tokens: 9, output_tokens: 9, usd: 9 }]);
    const log = memoryLogger();
    const guard = createBudgetGuard({ month: "2026-10", budgetUsd: 4, model: "claude-sonnet-5-5", store, log });
    guard.beforeCall(ctx);
    guard.afterCall(ctx, call); // 3.01 of 4 → 75%
    guard.afterCall(ctx, { ...call, searches: 0, input_tokens: 0, output_tokens: 10_000 }); // 3.11 → 78%
    expect(log.lines.filter((l) => l.includes("R10")).length).toBe(1);
    guard.afterCall(ctx, { ...call, searches: 0, input_tokens: 100_000, output_tokens: 0 }); // 3.31 → 83%
    expect(guard.level()).toBe("degraded80");
    expect(log.lines.some((l) => l.includes("only tier-1 festivals starting within 60 days"))).toBe(true);
    guard.afterCall(ctx, call); // over
    expect(() => guard.beforeCall(ctx)).toThrow(BudgetExceededError);
    expect(guard.calls).toBe(4);
    expect(store.saved.at(-1)!.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
  });

  test("every call is one ledger line tagged with its job; as() records another job on the same budget", () => {
    const store = memoryUsageStore([{ ...emptyMonth("2026-10"), usd: 1 }]);
    const guard = createBudgetGuard({ month: "2026-10", today: "2026-10-12", budgetUsd: 20, model: "claude-sonnet-5-5", store, log: memoryLogger(), job: "sweep" });
    guard.afterCall(ctx, call);
    guard.as("followup").afterCall({ key: "CO/y", kind: "extract" }, call);
    expect(store.entries.map((e) => [e.day, e.job, e.key, e.call])).toEqual([
      ["2026-10-12", "sweep", "CO/x", "research"],
      ["2026-10-12", "followup", "CO/y", "extract"],
    ]);
    expect(store.entries[0]).toMatchObject({ searches: 1, input_tokens: 1_000_000, output_tokens: 100_000, usd: 3.01 });
    expect(guard.calls).toBe(2);
    expect(guard.current().usd).toBeCloseTo(1 + 6.02, 6);
    expect(store.load()).toEqual([{ month: "2026-10", searches: 2, input_tokens: 2_000_000, output_tokens: 200_000, usd: 7.02 }]);
  });

  test("ledger file: missing is empty, each call appends one line, months are derived from the lines", () => {
    const root = tempRepo({ countries: [] });
    const path = join(root, "data", "state", "ledger.jsonl");
    const store = ledgerUsageStore(path);
    expect(store.load()).toEqual([]);
    const guard = createBudgetGuard({ month: "2026-11", today: "2026-11-09", budgetUsd: 20, model: "claude-sonnet-5-5", store, log: memoryLogger(), job: "onboard" });
    guard.afterCall({ key: "onboard/JP", kind: "research" }, call);
    guard.afterCall({ key: "onboard/JP", kind: "extract" }, { ...call, searches: 0 });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(store.load()).toEqual([{ month: "2026-11", searches: 1, input_tokens: 2_000_000, output_tokens: 200_000, usd: 6.01 }]);
    expect(readLedger(path).map((e) => e.job)).toEqual(["onboard", "onboard"]);
    expect(() => parseLedger('{"day":"2026-11-09"}\n')).toThrow(/ledger line 1/);
    expect(() => parseLedger("nope\n")).toThrow(/not JSON/);
    expect(parseLedger("\n\n")).toEqual([]);
  });
});

describe("what the ledger tells the planner", () => {
  const line = (over: Partial<LedgerEntry>): LedgerEntry => ({ day: "2026-11-02", job: "verify", key: "CO/a", call: "research", model: "m", searches: 0, input_tokens: 0, output_tokens: 0, usd: 0.1, ...over });
  const entries = [
    line({}),
    line({ call: "extract", usd: 0.05 }),
    line({ key: "CO/b", day: "2026-11-05", usd: 0.25 }),
    line({ job: "sweep", key: "CO/a", day: "2026-11-07", usd: 0.04 }),
    line({ job: "onboard", key: "onboard/JP", day: "2026-11-08", usd: 1.5 }),
    line({ job: "build", key: "JP/x", day: "2026-11-08", usd: 0.3 }),
    line({ job: "verify", key: "carryover/2026-10", day: "2026-10-31", call: "carryover", usd: 2.21 }),
  ];

  test("a job is one key on one day: the verification of CO/a cost 0.15, CO/b 0.25; carry-over is left out", () => {
    expect(averageJobCost(entries, "verify")).toEqual({ jobs: 2, usd: 0.2 });
    expect(averageJobCost(entries, "followup")).toEqual({ jobs: 0, usd: 0 });
  });

  test("spend splits into the new-country pool and upkeep", () => {
    expect(spendByPool(entries, "2026-11")).toEqual({ build: 1.8, upkeep: 0.44 });
    expect(spendByPool(entries, "2026-10")).toEqual({ build: 0, upkeep: 2.21 });
  });

  test("last day a festival was checked, per kind of job", () => {
    const checks = lastDays(entries, new Set(["verify", "followup", "build"]));
    expect(checks.get("CO/a")).toBe("2026-11-02");
    expect(checks.get("JP/x")).toBe("2026-11-08");
    expect(checks.has("carryover/2026-10")).toBe(false);
    expect(lastDays(entries, new Set(["sweep"])).get("CO/a")).toBe("2026-11-07");
  });
});

describe("budget inside a refresh run (R10)", () => {
  test("crossing the cap mid-run stops before the next call: no further API call, exit 1, nothing applied", async () => {
    const root = tempRepo();
    const out = join(root, "gh-output");
    writeFileSync(out, "");
    const before = readFileSync(join(root, "data", "countries", "co.json"), "utf8");
    const transport = fixtureDirTransport(REFRESH_FIXTURES);
    const usage = memoryUsageStore();
    const budgetUsd = 0.05;
    const result = await runRefresh(refreshOptions(root, { dryRun: false, budgetUsd, githubOutput: out }), { transport, archiver: noopArchiver, usage, log: memoryLogger() });

    expect(result.exitCode).toBe(1);
    expect(result.report?.stopped).toMatch(/monthly budget reached/);
    // Every call that got a response was recorded, and the cap was crossed by the last one. The
    // postponed Petronio 2026 queues first (ux-F01) and has no recording, so it costs nothing.
    const outcomes = result.report!.festivals.map((f) => f.outcome);
    const unrecorded = outcomes.filter((o) => o === "no_fixture").length;
    expect(transport.calls.length).toBe(usage.saved.length + unrecorded);
    expect(usage.saved.at(-2)!.at(-1)!.usd).toBeLessThan(budgetUsd);
    expect(usage.saved.at(-1)!.at(-1)!.usd).toBeGreaterThanOrEqual(budgetUsd);
    const ran = outcomes.filter((o) => o !== "no_fixture");
    expect(ran[0]).toBe("ok");
    expect(ran[1]).toBe("skipped_budget");
    expect(ran.slice(2).every((o) => o === "not_run")).toBe(true);
    expect(githubOutput(out).changes).toBe("0");
    expect(readFileSync(join(root, "data", "countries", "co.json"), "utf8")).toBe(before);
  });

  test("over budget before the run: zero calls and a non-zero exit", async () => {
    const root = tempRepo();
    const transport = fixtureDirTransport(REFRESH_FIXTURES);
    const usage = memoryUsageStore([{ month: "2026-10", searches: 0, input_tokens: 0, output_tokens: 0, usd: 25 }]);
    const result = await runRefresh(refreshOptions(root), { transport, archiver: noopArchiver, usage, log: memoryLogger() });
    expect(transport.calls).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    // Only the report, so the stop can be read from the run artifact; no data file is touched.
    expect(result.files.map((f) => f.slice(root.length + 1)).sort()).toEqual(["proposals/2026-10-26.json", "proposals/2026-10-26.md"]);
    expect(result.report!.festivals[0]!.outcome).toBe("skipped_budget");
  });

  test("at 80% only tier-1 festivals starting within 60 days are verified", async () => {
    const root = tempRepo();
    const at85 = () => memoryUsageStore([{ month: "2026-11", searches: 0, input_tokens: 0, output_tokens: 0, usd: 17 }]);
    const far = fixtureDirTransport(REFRESH_FIXTURES);
    await runRefresh(refreshOptions(root, { today: "2026-11-01" }), { transport: far, archiver: noopArchiver, usage: at85(), log: memoryLogger() });
    expect(far.calls.map((c) => c.ctx.key)).toEqual([]);
    const near = fixtureDirTransport(REFRESH_FIXTURES);
    const r = await runRefresh(refreshOptions(root, { today: "2026-11-05", only: "negros-y-blancos" }), { transport: near, archiver: noopArchiver, usage: at85(), log: memoryLogger() });
    expect(new Set(near.calls.map((c) => c.ctx.key))).toEqual(new Set(["CO/negros-y-blancos"]));
    expect(r.report!.applied.map((c) => c.field).sort()).toEqual(["end", "start", "status"]);
  });
});
