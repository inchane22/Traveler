import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  fileUsageStore,
  levelOf,
  memoryUsageStore,
  priceFor,
} from "../../scripts/lib/budget.ts";
import { fixtureDirTransport } from "../../scripts/lib/client.ts";
import { memoryLogger, readJson, writeJson } from "../../scripts/lib/io.ts";
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
    expect(guard.firstRunOfMonth).toBe(true);
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

  test("a month already on record is not a first run", () => {
    const guard = createBudgetGuard({ month: "2026-10", budgetUsd: 20, model: "m", store: memoryUsageStore([emptyMonth("2026-10")]), log: memoryLogger() });
    expect(guard.firstRunOfMonth).toBe(false);
  });

  test("data/usage.json store: missing file is empty, writes the whole history", () => {
    const root = tempRepo({ countries: [] });
    const path = join(root, "data", "usage-test.json");
    const store = fileUsageStore(path, { read: readJson, write: writeJson, exists: existsSync });
    expect(store.load()).toEqual([]);
    store.save([emptyMonth("2026-10")]);
    expect(store.load()).toEqual([emptyMonth("2026-10")]);
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
    // Every call that was sent was recorded, and the cap was crossed by the last one.
    expect(transport.calls.length).toBe(usage.saved.length);
    expect(usage.saved.at(-2)!.at(-1)!.usd).toBeLessThan(budgetUsd);
    expect(usage.saved.at(-1)!.at(-1)!.usd).toBeGreaterThanOrEqual(budgetUsd);
    const outcomes = result.report!.festivals.map((f) => f.outcome);
    expect(outcomes[0]).toBe("ok");
    expect(outcomes[1]).toBe("skipped_budget");
    expect(outcomes.slice(2).every((o) => o === "not_run")).toBe(true);
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
    expect(result.files).toEqual([]);
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
