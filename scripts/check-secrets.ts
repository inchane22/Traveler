// Fails when a secret appears in a tracked file or in dist/ (PRD «Chequeo en CI», R8). Fails closed:
// if git cannot list the tracked files, or a file cannot be read, the scan is an error, never clean.
// Every prefix is assembled at runtime so this file never matches itself.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/is-main.ts";

const j = (...parts: string[]): string => parts.join("");

/**
 * What a leak looks like: a prefix plus a long token body, so the bare prefix in docs is not one.
 * Anthropic keys, GitHub tokens (classic, fine-grained, app installation), PEM private keys (the
 * PR app key) and long values assigned to the archive and trap secret names.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Anthropic API key", pattern: new RegExp(`${j("sk", "-ant-")}[A-Za-z0-9_-]{20,}`) },
  { name: "GitHub token", pattern: new RegExp(`\\b(${j("gh", "p_")}|${j("gh", "s_")}|${j("gh", "o_")}|${j("gh", "u_")})[A-Za-z0-9]{30,}`) },
  { name: "GitHub fine-grained token", pattern: new RegExp(`\\b${j("github", "_pat_")}[A-Za-z0-9_]{40,}`) },
  { name: "private key", pattern: new RegExp(`-----${j("BEGIN ", "(?:[A-Z]+ )?", "PRIVATE KEY")}-----`) },
  { name: "archive or trap secret value", pattern: new RegExp(`\\b(${j("ARCHIVE", "_ACCESS_KEY")}|${j("ARCHIVE", "_SECRET_KEY")}|${j("TRAP", "_SECRET")})[ \\t]*[:=][ \\t]*["']?(?!op://)[A-Za-z0-9+/=_-]{16,}`) },
];

export class ScanError extends Error {}

/** Tracked files from git; throws when git fails or lists nothing (no silent pass). */
export function trackedFiles(run: () => string = () => execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })): string[] {
  let out: string;
  try {
    out = run();
  } catch (error) {
    throw new ScanError(`git ls-files failed, tracked files were not scanned: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = out.split("\0").filter(Boolean);
  if (!files.length) throw new ScanError("git ls-files returned no files; tracked files were not scanned");
  return files;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export interface ScanResult {
  leaks: Array<{ path: string; kind: string }>;
  unreadable: string[];
}

/** Every file is read; one that cannot be read is reported, not skipped as clean. */
export function scan(paths: readonly string[], read: (p: string) => string): ScanResult {
  const leaks: ScanResult["leaks"] = [];
  const unreadable: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = read(path);
    } catch {
      unreadable.push(path);
      continue;
    }
    const hit = SECRET_PATTERNS.find((p) => p.pattern.test(text));
    if (hit) leaks.push({ path, kind: hit.name });
  }
  return { leaks, unreadable };
}

/** Paths that hold a secret (kept for callers that only need the list). */
export function findLeaks(paths: readonly string[], read: (p: string) => string): string[] {
  return scan(paths, read).leaks.map((l) => l.path);
}

/** Tracked files that were deleted in the working tree are not a scan failure. */
function existing(paths: readonly string[]): string[] {
  return paths.filter((p) => existsSync(p));
}

export function main(): number {
  let tracked: string[];
  try {
    tracked = existing(trackedFiles());
  } catch (error) {
    console.error(`check-secrets: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const dist = walk("dist");
  const { leaks, unreadable } = scan([...tracked, ...dist], (p) => readFileSync(p, "utf8"));
  if (leaks.length > 0) {
    console.error(`Secret found in ${leaks.length} file(s):\n${leaks.map((l) => `${l.path} (${l.kind})`).join("\n")}`);
    console.error("Revoke the secret now (Claude Console, GitHub, archive.org), then follow the rotation runbook in README.md.");
    return 1;
  }
  if (unreadable.length > 0) {
    console.error(`check-secrets: ${unreadable.length} file(s) could not be read, so the scan is incomplete:\n${unreadable.join("\n")}`);
    return 1;
  }
  console.log(`check-secrets: ${tracked.length} tracked and ${dist.length} dist files scanned, no secret found.`);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) process.exit(main());
