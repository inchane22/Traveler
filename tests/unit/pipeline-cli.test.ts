// The three scripts as CI runs them: separate node processes, recorded responses, no network, no key.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FIXTURES, githubOutput, REFRESH_FIXTURES, REPO, tempRepo, TODAY } from "../fixtures/pipeline/helpers.ts";

function run(script: string, args: readonly string[], cwd: string, env: Record<string, string> = {}) {
  // Only PATH from the parent: no ANTHROPIC_API_KEY or other secret reaches the child.
  const r = spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("pipeline CLIs (offline)", () => {
  test("refresh: --fixtures with --dry-run writes the proposals, exits 0 and reports what it holds", () => {
    const root = tempRepo({ countries: ["co"] });
    // The recorded responses were captured against the PRD-era CO file: replay them against that frozen copy.
    cpSync(join(REPO, "tests", "fixtures", "prd", "co.json"), join(root, "data", "countries", "co.json"));
    const out = join(root, "gh");
    writeFileSync(out, "");
    const r = run("refresh.ts", ["--dry-run", "--country=CO", `--today=${TODAY}`, `--fixtures=${REFRESH_FIXTURES}`], root, { GITHUB_OUTPUT: out });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`wrote .*/proposals/${TODAY}\\.md`));
    const values = githubOutput(out);
    expect(values).toMatchObject({ flagged: "4", unexpected: "0" });
    expect(values.branch).toBeUndefined();
    expect(existsSync(join(root, "data", "state", "ledger.jsonl"))).toBe(false);
  });

  test("refresh: a bad flag exits 2 before any work", () => {
    const r = run("refresh.ts", ["--max=3"], tempRepo({ countries: ["co"] }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument: --max=3/);
  });

  test("onboard: --fixtures writes a «borrador» country file", () => {
    const root = tempRepo({ countries: ["co"] });
    const r = run("onboard.ts", ["--country=PE", `--today=${TODAY}`, `--fixtures=${FIXTURES}`], root);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(root, "data", "countries", "pe.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "data", "countries", "pe.json"), "utf8")).status).toBe("borrador");
  });
});
