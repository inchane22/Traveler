// Fails when an Anthropic key prefix appears in a tracked file or in dist/ (PRD «Chequeo en CI», R8).
// The prefix is assembled at runtime so this file never matches itself.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/is-main.ts";

const PREFIX = ["sk", "ant", ""].join("-");
// A real key is the prefix plus a long token body; the bare prefix in docs is not a leak.
const KEY_PATTERN = new RegExp(`${PREFIX}[A-Za-z0-9_-]{20,}`);

function trackedFiles(): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function findLeaks(paths: readonly string[], read: (p: string) => string): string[] {
  return paths.filter((path) => {
    try {
      return KEY_PATTERN.test(read(path));
    } catch {
      return false;
    }
  });
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const files = [...trackedFiles(), ...walk("dist")];
  const leaks = findLeaks(files, (p) => readFileSync(p, "utf8"));
  if (leaks.length > 0) {
    console.error(`Anthropic API key found in ${leaks.length} file(s):\n${leaks.join("\n")}`);
    console.error("Revoke the key in the Claude Console now, then follow the rotation runbook in README.md.");
    process.exit(1);
  }
  console.log(`check-secrets: ${files.length} files scanned, no API key found.`);
}
