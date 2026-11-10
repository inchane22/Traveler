// The whole pipeline run on recorded responses: intake, the R2 publish gate, a new country built
// from nothing (policy fallback, onboarding, top-up), the budget wait, state files and the run's
// summary, commit message and issue replies.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main as pipelineMain } from "../../scripts/pipeline.ts";
import { noopArchiver } from "../../scripts/lib/archive.ts";
import { memoryUsageStore } from "../../scripts/lib/budget.ts";
import { fixtureDirTransport } from "../../scripts/lib/client.ts";
import { memoryLogger } from "../../scripts/lib/io.ts";
import type { LedgerEntry } from "../../scripts/lib/ledger.ts";
import { commitMessage, runPipeline, type IssueUpdate, type PipelineOptions } from "../../scripts/lib/pipeline-run.ts";
import { readRequests, type CountryRequest } from "../../scripts/lib/requests.ts";
import { CountryFile } from "../../src/schema.ts";
import { FIXTURES, readJsonFile, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";

const opts = (root: string, over: Partial<PipelineOptions> = {}): PipelineOptions => ({
  root,
  today: TODAY,
  model: "claude-sonnet-5-5",
  budgetUsd: 20,
  maxFestivals: 40,
  maxFollowups: 6,
  planOnly: false,
  siteUrl: "https://example.github.io/Traveler/",
  ...over,
});

function deps(over: { ledger?: LedgerEntry[] } = {}) {
  const usage = memoryUsageStore();
  const transport = fixtureDirTransport(FIXTURES);
  const log = memoryLogger();
  return { transport, archiver: noopArchiver, usage, ledger: () => [...(over.ledger ?? []), ...usage.entries], log };
}

const keys = (d: ReturnType<typeof deps>): string[] => d.transport.calls.map((c) => c.ctx.key);

function writeRequests(root: string, requests: CountryRequest[]): void {
  mkdirSync(join(root, "data", "state"), { recursive: true });
  writeFileSync(join(root, "data", "state", "requests.json"), `${JSON.stringify(requests, null, 2)}\n`);
}

const status = (root: string, cc: string) => CountryFile.parse(readJsonFile(join(root, "data", "countries", `${cc.toLowerCase()}.json`))).status;
const asDraft = (root: string, cc: string) => {
  const path = join(root, "data", "countries", `${cc.toLowerCase()}.json`);
  writeFileSync(path, readFileSync(path, "utf8").replace('"status": "publicado"', '"status": "borrador"'));
};

describe("pipeline: plan only", () => {
  test("no API call, no state written; the summary says what would run", async () => {
    const root = tempRepo({ countries: ["co", "pe"] });
    const d = deps();
    const result = await runPipeline(opts(root, { planOnly: true, request: { country: "JP" } }), d);
    expect(d.transport.calls).toEqual([]);
    expect(existsSync(join(root, "data", "state", "requests.json"))).toBe(false);
    const md = readFileSync(join(root, "proposals", `pipeline-${TODAY}.md`), "utf8");
    expect(md).toContain(`## Pipeline ${TODAY} (plan only)`);
    // 2026-10-26 is in the month's last week: upkeep and new countries share what is left.
    expect(md).toMatch(/Budget 2026-10: US\$0\.00 spent before this run of US\$20\.00 \(upkeep US\$0\.00, new countries US\$0\.00\)\. Last days of the month: both share the US\$20\.00 left, upkeep first\./);
    expect(result.plan.builds.map((b) => b.country)).toEqual(["JP"]);
  });
});

describe("pipeline: a request for a draft that already passes R2", () => {
  test("Peru is published without any API call for it; the request is live and its issue gets the link and is closed", async () => {
    const root = tempRepo({ countries: ["co", "pe"] });
    asDraft(root, "PE");
    expect(status(root, "PE")).toBe("borrador");
    const d = deps();
    const out = join(root, "gh");
    writeFileSync(out, "");
    const result = await runPipeline(opts(root, { request: { country: "pe", issue: 12 }, githubOutput: out }), d);
    expect(status(root, "PE")).toBe("publicado");
    expect(result.summary.published).toEqual(["PE"]);
    expect(readRequests(root)).toEqual([expect.objectContaining({ country: "PE", status: "live", issue: 12, live_since: TODAY })]);
    expect(result.summary.issues).toEqual<IssueUpdate[]>([{ issue: 12, comment: "Peru is live with 4 festivals. https://example.github.io/Traveler/#/pais/pe", close: true }]);
    expect(readJsonFile(join(root, "proposals", "issue-updates.json"))).toEqual(result.summary.issues);
    // Nothing was built: Peru never went through onboarding.
    expect(keys(d).some((k) => k.startsWith("onboard/"))).toBe(false);
    expect(readFileSync(join(root, "proposals", "commit-message.txt"), "utf8")).toMatch(/^chore\(data\): pipeline 2026-10-26 · \d+ applied.* · PE live\n/);
  });

  test("an issue without a valid code is refused and closed with the reason; nothing is queued", async () => {
    const root = tempRepo({ countries: ["co"] });
    const result = await runPipeline(opts(root, { request: { country: "??", issue: 5 } }), deps());
    expect(result.summary.intake).toMatchObject({ accepted: false });
    expect(result.summary.issues).toEqual([{ issue: 5, comment: expect.stringMatching(/^Could not queue this: .*two-letter/), close: true }]);
    expect(readRequests(root)).toEqual([]);
  });
});

describe("pipeline: building a country from nothing", () => {
  /** A repo copy as before PE was ever requested: no data file and no domain config. */
  const freshRoot = () => {
    const root = tempRepo({ countries: ["co"] });
    for (const dir of ["sources", "official-domains"]) rmSync(join(root, "config", dir, "pe.json"), { force: true });
    return root;
  };

  test("policy (fallback when the call fails), onboarding, date top-up; short of R2 it waits 30 days and says so", async () => {
    const root = freshRoot();
    const d = deps();
    const result = await runPipeline(opts(root, { request: { country: "PE", issue: 21 } }), d);
    const calls = keys(d);
    expect(calls[0]).toBe("policy/PE");
    expect(calls).toContain("onboard/PE");
    expect(calls.some((k) => k.startsWith("PE/"))).toBe(true);
    // The policy call had no recording: government domains and UNESCO only.
    expect(readJsonFile<{ A: string[]; B: string[] }>(join(root, "config", "sources", "pe.json"))).toMatchObject({ B: [], A: expect.arrayContaining(["gob.pe", "unesco.org"]) });
    expect(status(root, "PE")).toBe("borrador");
    expect(result.summary.builds).toEqual([expect.objectContaining({ country: "PE", outcome: "retry", needed: 3 })]);
    expect(readRequests(root)).toEqual([expect.objectContaining({ country: "PE", status: "retry", attempts: 1, retry_after: "2026-11-25", issue: 21 })]);
    expect(result.summary.issues).toEqual([{ issue: 21, comment: expect.stringMatching(/^Built Peru, but it is not live yet: \d of 3 festivals with a date on an A or B source\. Next try on 2026-11-25\.$/), close: false }]);
    // Every call that returned is on the ledger with its job: onboarding as «onboard» (new-country
    // money), the live Colombia's checks as upkeep; the top-up had no recordings, so cost nothing.
    const onboarding = d.usage.entries.filter((e) => e.key === "onboard/PE");
    expect(onboarding.length).toBeGreaterThan(0);
    expect(onboarding.every((e) => e.job === "onboard" && e.day === TODAY)).toBe(true);
    expect(d.usage.entries.filter((e) => e.key.startsWith("CO/")).every((e) => ["verify", "followup", "sweep"].includes(e.job))).toBe(true);
  });

  test("when this month's new-country money is spent, the request waits for next month and the issue says when", async () => {
    // Mid-month (in the last week the two shares pool what is left).
    const root = freshRoot();
    const spent: LedgerEntry = { day: "2026-11-02", job: "onboard", key: "onboard/XX", call: "research", model: "m", searches: 0, input_tokens: 0, output_tokens: 0, usd: 5.9 };
    const d = deps({ ledger: [spent] });
    const result = await runPipeline(opts(root, { today: "2026-11-10", request: { country: "PE", issue: 30 } }), d);
    expect(result.plan.builds).toEqual([]);
    expect(result.plan.waiting).toEqual([expect.objectContaining({ country: "PE", reason: "budget", until: "2026-12-01" })]);
    expect(readRequests(root)).toEqual([expect.objectContaining({ country: "PE", status: "queued" })]);
    expect(result.summary.issues).toEqual([{ issue: 30, comment: "Peru is queued. This month's new-country budget is used; it starts on 2026-12-01.", close: false }]);
    expect(keys(d).filter((k) => k.startsWith("onboard/") || k.startsWith("policy/"))).toEqual([]);
  });
});

describe("pipeline: upkeep of live countries", () => {
  test("planned festivals are verified, accepted changes applied, held ones written to holds.json, all on the ledger", async () => {
    const root = tempRepo({ countries: ["co"] });
    const d = deps();
    const result = await runPipeline(opts(root), d);
    const planned = result.plan.verify.length + result.plan.sweep.length;
    expect(planned).toBeGreaterThan(0);
    // Verifications and sweeps are tagged so the planner can price and space them next time.
    expect(d.usage.entries.every((e) => ["verify", "followup", "sweep"].includes(e.job))).toBe(true);
    const holds = readJsonFile<unknown[]>(join(root, "data", "state", "holds.json"));
    expect(holds).toHaveLength(result.summary.flagged.length);
    expect(readFileSync(join(root, "proposals", "holds.md"), "utf8")).toMatch(/Updated 2026-10-26 by the pipeline/);
    expect(result.summary.spend.after).toBeGreaterThanOrEqual(result.summary.spend.before);
  });

  test("the commit message lists every applied change and new festival with its source and the month's spend", () => {
    const summary = {
      kind: "pipeline" as const,
      date: TODAY,
      plan_only: false,
      intake: null,
      covered: [],
      published: [],
      builds: [{ country: "JP", outcome: "live" as const, sourced: 4, needed: 3 }],
      discovered: [],
      applied: [{ country: "CO", slug: "feria-de-cali", year: 2026, field: "start", old: null, new: "2026-12-25", sources: [{ url: "https://www.cali.gov.co/feria" }] } as never],
      confirmations: 2,
      flagged: [],
      rejected: 0,
      unexpected: 0,
      stopped: [],
      spend: { month: "2026-10", before: 1, after: 1.5, budget: 20 },
      holds: 0,
      issues: [],
    };
    const msg = commitMessage(summary);
    expect(msg.split("\n")[0]).toBe("chore(data): pipeline 2026-10-26 · 1 applied · JP live");
    expect(msg).toContain("- CO feria-de-cali 2026 inicio: — → 2026-12-25 (https://www.cali.gov.co/feria)");
    expect(msg).toContain("Spend 2026-10: US$1.50 of US$20.00 (this run US$0.50).");
    const grown = commitMessage({ ...summary, discovered: [{ country: "AR", slug: "fiesta-x", name: "Fiesta X", city: "Salta", dated: true, sources: ["https://www.salta.gob.ar/x"] }] });
    expect(grown.split("\n")[0]).toBe("chore(data): pipeline 2026-10-26 · 1 applied · 1 new · JP live");
    expect(grown).toContain("- AR fiesta-x: Fiesta X, Salta (https://www.salta.gob.ar/x)");
  });
});

describe("pnpm pipeline (CLI)", () => {
  test("--plan offline: exit 0, reads the issue from env vars, writes the summary, appends nothing to the ledger", async () => {
    const root = tempRepo({ countries: ["co"] });
    const log = memoryLogger();
    const code = await pipelineMain(["--plan", `--today=${TODAY}`, `--fixtures=${FIXTURES}`], { ISSUE_NUMBER: "3", ISSUE_TITLE: "Build: JP", ISSUE_BODY: "" }, root, log);
    expect(code).toBe(0);
    expect(log.lines[0]).toBe("R10: US$0.00 of US$20.00 spent in 2026-10");
    expect(readJsonFile<{ plan: { builds: Array<{ country: string }> } }>(join(root, "proposals", `pipeline-${TODAY}.json`)).plan.builds.map((b) => b.country)).toEqual(["JP"]);
    expect(existsSync(join(root, "data", "state", "ledger.jsonl"))).toBe(false);
    expect(await pipelineMain(["--request=JPN"], {}, root, memoryLogger())).toBe(2);
  });
});
