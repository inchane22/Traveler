// Ops wiring that no other test exercises: the pipeline commits only validated data and treats
// issue text as data (SEC-02), deploy waits for CI (prd-F17), package scripts point at real files
// (code-F8, code-F9), the unit suite runs west of UTC (prd-F19) and the built CSP (prd-F13).
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { cspMetas, cspProblem } from "../../scripts/check-csp.ts";
import { formatDayMonth, todayIn } from "../../src/dates.ts";
import { CSP } from "../../vite.config.ts";

const read = (p: string): string => readFileSync(p, "utf8");
const stepOf = (wf: string, name: string): string => {
  const at = wf.indexOf(`- name: ${name}`);
  expect(at, name).toBeGreaterThan(0);
  const next = wf.indexOf("\n      - name:", at + 1);
  return wf.slice(at, next === -1 ? undefined : next);
};

describe("pipeline.yml: auto-approved data reaches main only through the checks", () => {
  const wf = read(".github/workflows/pipeline.yml");

  test("one workflow replaces refresh, onboard and the usage hand-off; runs one at a time", () => {
    for (const gone of ["refresh.yml", "onboard.yml", "usage-fallback.yml"]) expect(existsSync(`.github/workflows/${gone}`)).toBe(false);
    expect(wf).toMatch(/group: ai-pipeline\s*\n\s*cancel-in-progress: false/);
    expect(wf).toContain('cron: "0 11 * * *"');
    expect(wf).toMatch(/issues:\s*\n\s*types: \[opened, reopened, labeled\]/);
  });

  test("only the owner's «build-country» issues spend; anyone else's gets a reply without the API key", () => {
    expect(wf).toContain("github.event.issue.author_association == 'OWNER'");
    expect(wf).toContain("github.event.sender.login == github.repository_owner");
    expect(wf).toContain("contains(github.event.issue.labels.*.name, 'build-country')");
    // GitHub drops a form's label that does not exist yet: the owner's «Build:» title still counts.
    expect(wf).toContain("startsWith(github.event.issue.title, 'Build:')");
    const ack = wf.slice(wf.indexOf("  acknowledge:"), wf.indexOf("  pipeline:"));
    expect(ack).not.toContain("ANTHROPIC_API_KEY");
    expect(ack).not.toContain("environment:");
  });

  test("issue text reaches the script through env vars only, never inside a run script", () => {
    const run = stepOf(wf, "Run the pipeline");
    expect(run).toContain("ISSUE_BODY: ${{ github.event_name == 'issues' && github.event.issue.body || '' }}");
    for (const script of wf.split("run: |").slice(1)) expect(script.split("\n      - name:")[0]).not.toMatch(/\$\{\{\s*github\.event\.issue\.(body|title)/);
  });

  test("build-data validates before the commit; the commit goes to main; CI is started after the push", () => {
    const validate = wf.indexOf("- name: Validate data and regenerate data/index.json");
    const commit = wf.indexOf("- name: Commit to main");
    const ci = wf.indexOf("- name: Start CI on main");
    expect(validate).toBeGreaterThan(wf.indexOf("- name: Run the pipeline"));
    expect(commit).toBeGreaterThan(validate);
    expect(ci).toBeGreaterThan(commit);
    expect(stepOf(wf, "Commit to main")).toContain("HEAD:main");
    expect(stepOf(wf, "Start CI on main (deploy follows a green run)")).toContain("gh workflow run ci.yml");
    expect(wf).toContain("actions: write");
  });

  test("data build-data rejects is dropped, but its spend is still committed (R10), and nothing is deployed or announced", () => {
    const commit = stepOf(wf, "Commit to main");
    expect(commit).toContain("VALID: ${{ steps.validate.outcome }}");
    expect(commit).toContain("paths=(data/state/ledger.jsonl)");
    expect(commit).toContain("git checkout -- data/countries data/changelog.json data/index.json config");
    expect(stepOf(wf, "Start CI on main (deploy follows a green run)")).toContain("steps.validate.outcome == 'success'");
    expect(wf).toMatch(/- name: Answer request issues\n\s*if: .*steps\.validate\.outcome == 'success'/);
    expect(stepOf(wf, "Fail when the pipeline did")).toContain("steps.validate.outcome == 'failure'");
  });

  test("a failed pipeline step still commits what was applied, then turns the run red (BE-04)", () => {
    expect(stepOf(wf, "Run the pipeline")).toContain("continue-on-error: true");
    const fail = stepOf(wf, "Fail when the pipeline did");
    expect(wf.indexOf("- name: Fail when the pipeline did")).toBeGreaterThan(wf.indexOf("- name: Commit to main"));
    expect(fail).toContain("steps.run.outcome == 'failure'");
    expect(fail).toContain("exit 1");
    expect(read("scripts/lib/pipeline-run.ts")).toMatch(/summary\.unexpected > 0 \? 1 : 0/);
  });

  test("no workflow or script still refers to the monthly reviewer trap", () => {
    for (const f of [".github/workflows/ci.yml", ".github/workflows/deploy.yml", ".github/workflows/pipeline.yml", "package.json"]) expect(read(f)).not.toMatch(/check-trap|TRAP_FINGERPRINTS/);
    expect(existsSync("scripts/check-trap.ts")).toBe(false);
  });
});

describe("deploy waits for a green ci run on main (prd-F17)", () => {
  const deploy = read(".github/workflows/deploy.yml");
  test("triggered by ci's workflow_run (a push or the pipeline's dispatch), not by a raw push, and builds the verified commit", () => {
    expect(deploy).toMatch(/workflow_run:\s*\n\s*workflows: \[ci\]/);
    expect(deploy).not.toMatch(/^\s*push:/m);
    expect(deploy).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploy).toContain("(github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'workflow_dispatch')");
    expect(deploy).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deploy).toContain("ref: ${{ github.event.workflow_run.head_sha || github.sha }}");
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(ci).toMatch(/^\s*workflow_dispatch:/m);
  });
});

describe("package scripts", () => {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
  test("every `node scripts/*.ts` a script runs exists (code-F9)", () => {
    const files = Object.values(scripts).flatMap((cmd) => [...cmd.matchAll(/node (scripts\/[\w./-]+\.ts)/g)].map((m) => m[1]!));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(existsSync(f), f).toBe(true);
  });

  test("pnpm dev includes drafts, the production build never does (code-F8)", () => {
    expect(scripts.dev).toMatch(/^INCLUDE_DRAFTS=1 pnpm run data/);
    expect(scripts.build).not.toContain("INCLUDE_DRAFTS");
    expect(scripts.build).toContain("node scripts/check-csp.ts");
  });
});

describe("unit tests run in Lima, west of UTC (prd-F19)", () => {
  test("the process zone is America/Lima, so a local-time regression shows up here", () => {
    expect(new Date("2027-04-13T12:00:00Z").getTimezoneOffset()).toBe(300);
    // 00:30 UTC on the 14th is still the 13th in Lima and already the 14th in Tokyo.
    const now = new Date("2027-04-14T00:30:00Z");
    expect(todayIn("America/Lima", now)).toBe("2027-04-13");
    expect(todayIn("Asia/Tokyo", now)).toBe("2027-04-14");
    expect(formatDayMonth("2027-04-13", "es-PE")).toContain("13");
  });
});

describe("Content-Security-Policy of the built pages (prd-F13)", () => {
  const meta = (content: string) => `<meta http-equiv="Content-Security-Policy" content="${content.replace(/'/g, "&#39;")}">`;
  test("the exact policy passes; missing, doubled or loosened ones fail", () => {
    expect(cspProblem(`<head>${meta(CSP)}</head>`, CSP)).toBeNull();
    expect(cspProblem("<head></head>", CSP)).toMatch(/no Content-Security-Policy/);
    expect(cspProblem(`${meta(CSP)}${meta(CSP)}`, CSP)).toMatch(/2 Content-Security-Policy/);
    expect(cspProblem(meta(CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")), CSP)).toMatch(/differs/);
  });

  test("the declared policy keeps the H7 directives", () => {
    for (const d of ["default-src 'self'", "script-src 'self'", "form-action 'none'", "base-uri 'self'"]) expect(CSP).toContain(d);
  });

  test("dist/index.html, when built, carries it", () => {
    if (!existsSync("dist/index.html")) return;
    expect(cspMetas(read("dist/index.html"))).toEqual([CSP]);
  });
});
