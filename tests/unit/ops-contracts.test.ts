// Ops wiring that no other test exercises: the R12 fingerprint reaches the secret CI reads
// (code-F1, SEC-02), deploy waits for CI (prd-F17), package scripts point at real files
// (code-F8, code-F9), the unit suite runs west of UTC (prd-F19) and the built CSP (prd-F13).
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { cspMetas, cspProblem } from "../../scripts/check-csp.ts";
import { formatDayMonth, todayIn } from "../../src/dates.ts";
import { CSP } from "../../vite.config.ts";

const read = (p: string): string => readFileSync(p, "utf8");

describe("R12: the trap fingerprint is stored where ci.yml and deploy.yml read it", () => {
  const refresh = read(".github/workflows/refresh.yml");
  test("refresh-run writes trap_fingerprint, and refresh.yml consumes it before the PR opens", () => {
    expect(read("scripts/lib/refresh-run.ts")).toContain("trap_fingerprint");
    expect(refresh).toMatch(/id: refresh\b/);
    expect(refresh).toContain("steps.refresh.outputs.trap_fingerprint");
    expect(refresh).toContain("gh secret set TRAP_FINGERPRINTS");
    expect(refresh).toContain("permission-secrets: write");
    const store = refresh.indexOf("name: Store the trap fingerprint");
    const pr = refresh.indexOf("peter-evans/create-pull-request");
    expect(store).toBeGreaterThan(0);
    expect(store).toBeLessThan(pr);
    // Fail closed: neither the store step nor the PR step runs with always(), so a failed store
    // means no PR; and no app means no trap.
    const step = (at: number) => refresh.slice(at, refresh.indexOf("\n      - name:", at + 1));
    expect(step(store)).not.toContain("always()");
    expect(step(refresh.lastIndexOf("- name: Open pull request", pr))).not.toContain("always()");
    expect(refresh).toContain("TRAP_SECRET: ${{ vars.PR_APP_CLIENT_ID != '' && secrets.TRAP_SECRET || '' }}");
  });

  test("unexpected per-festival errors turn the run red only after the PR for the rest has opened (BE-04)", () => {
    expect(read("scripts/lib/refresh-run.ts")).toMatch(/unexpected, verified/);
    const gate = refresh.indexOf("- name: Fail on unexpected festival errors");
    expect(gate).toBeGreaterThan(refresh.indexOf("- name: Report pull request"));
    const step = refresh.slice(gate, refresh.indexOf("\n      - name:", gate + 1));
    expect(step).toContain("steps.refresh.outputs.unexpected");
    expect(step).toContain("exit 1");
    expect(step).not.toContain("always()");
  });

  test("ci.yml and deploy.yml check against the same secret", () => {
    for (const wf of [".github/workflows/ci.yml", ".github/workflows/deploy.yml"]) {
      expect(read(wf)).toContain("TRAP_FINGERPRINTS: ${{ secrets.TRAP_FINGERPRINTS }}");
      expect(read(wf)).toContain("node scripts/check-trap.ts");
    }
  });
});

describe("deploy waits for a green ci run on main (prd-F17)", () => {
  const deploy = read(".github/workflows/deploy.yml");
  test("triggered by ci's workflow_run, not by a raw push, and builds the verified commit", () => {
    expect(deploy).toMatch(/workflow_run:\s*\n\s*workflows: \[ci\]/);
    expect(deploy).not.toMatch(/^\s*push:/m);
    expect(deploy).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploy).toContain("github.event.workflow_run.event == 'push'");
    expect(deploy).toContain("ref: ${{ github.event.workflow_run.head_sha || github.sha }}");
    expect(read(".github/workflows/ci.yml")).toMatch(/push:\s*\n\s*branches: \[main\]/);
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
