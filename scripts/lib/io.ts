// Small fs and logging helpers shared by the pipeline scripts. Writes are whole-file and atomic
// (write to a temp file, then rename) so an interrupted run never leaves half a JSON file.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Plain stdout/stderr logger (no console.* in committed code). */
export const stdLogger: Logger = {
  info: (m) => process.stdout.write(`${m}\n`),
  warn: (m) => process.stderr.write(`warning: ${m}\n`),
  error: (m) => process.stderr.write(`error: ${m}\n`),
};

export interface MemoryLogger extends Logger {
  lines: string[];
}

export function memoryLogger(): MemoryLogger {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(m),
    warn: (m) => lines.push(`warning: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
  };
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function readJsonOr(path: string, fallback: unknown): unknown {
  return existsSync(path) ? readJson(path) : fallback;
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function depth(v: unknown): number {
  if (Array.isArray(v)) return Number.POSITIVE_INFINITY;
  if (!isObject(v)) return 0;
  return 1 + Math.max(0, ...Object.values(v).map(depth));
}

/**
 * The repo's hand-written JSON style (data/countries/co.json round-trips unchanged): small leaf
 * objects on one line, anything holding arrays or many nested objects expanded. Keeps PR diffs
 * to the lines that really changed, which matters for the human review (R12).
 */
export function formatJson(value: unknown, indent = 0): string {
  if (!isObject(value) && !Array.isArray(value)) return JSON.stringify(value) ?? "null";
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every((x) => !isObject(x) && !Array.isArray(x))) return `[${value.map((x) => JSON.stringify(x)).join(", ")}]`;
    return `[\n${value.map((x) => pad + formatJson(x, indent + 2)).join(",\n")}\n${close}]`;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (!keys.length) return "{}";
  const nested = keys.filter((k) => isObject(value[k]) || value[k] === null).length;
  if (depth(value) <= 2 && nested <= 2) return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${formatJson(value[k], indent)}`).join(", ")} }`;
  return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${formatJson(value[k], indent + 2)}`).join(",\n")}\n${close}}`;
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${formatJson(value)}\n`);
}

/** Appends `key=value` lines to $GITHUB_OUTPUT (never overwrites). Values must be single-line. */
export function appendGithubOutput(path: string | undefined, values: Record<string, string | number>): void {
  if (!path) return;
  const lines = Object.entries(values).map(([k, v]) => {
    const s = String(v);
    if (/[\r\n]/.test(s)) throw new Error(`GITHUB_OUTPUT value for ${k} must be single-line`);
    return `${k}=${s}\n`;
  });
  appendFileSync(path, lines.join(""));
}

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

/** Loads a prompt template from scripts/prompts/ and fills `{{name}}` placeholders. */
export function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  const raw = readFileSync(new URL(name, PROMPTS_DIR), "utf8");
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`prompt ${name}: missing value for {{${key}}}`);
    return value;
  }).trim();
}

/** proposals/*.json file names, oldest first. */
export function listProposals(root: string): string[] {
  const dir = join(root, "proposals");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}
