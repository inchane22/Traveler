// R12: fails (exit 1) when data/changelog.json or the current proposals contain a trap change, so CI
// blocks it even if a reviewer approved it. Needs TRAP_SECRET and TRAP_FINGERPRINTS (comma-separated).
//   node scripts/check-trap.ts [--proposals=<file.json>] [--verbose]
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags, UsageError } from "./lib/args.ts";
import { listProposals, readJson, readJsonOr, stdLogger, type Logger } from "./lib/io.ts";
import { findTraps, parseFingerprints, type Fingerprintable } from "./lib/trap.ts";

const CHANGE_LISTS = ["applied", "confirmations", "flagged", "rejected", "deferred", "changes"] as const;

function isChange(v: unknown): v is Fingerprintable {
  const c = v as Partial<Fingerprintable> | null;
  return !!c && typeof c.country === "string" && typeof c.slug === "string" && typeof c.field === "string" && "new" in c;
}

/** Every change-like entry of a proposals file (refresh or onboarding). */
export function changesInProposal(json: unknown): Fingerprintable[] {
  if (!json || typeof json !== "object") return [];
  const record = json as Record<string, unknown>;
  return CHANGE_LISTS.flatMap((key) => (Array.isArray(record[key]) ? (record[key] as unknown[]).filter(isChange) : []));
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv, root = process.cwd(), log: Logger = stdLogger): number {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      log.error(error.message);
      return 2;
    }
    throw error;
  }
  const secret = env.TRAP_SECRET?.trim();
  const fingerprints = parseFingerprints(env.TRAP_FINGERPRINTS);
  if (!secret) {
    if (fingerprints.size) {
      log.error("R12: TRAP_FINGERPRINTS is set but TRAP_SECRET is missing; cannot check for trap changes");
      return 1;
    }
    log.info("R12: TRAP_SECRET not set; trap check skipped");
    return 0;
  }
  const proposalsFlag = flags.get("proposals");
  const files = typeof proposalsFlag === "string" ? [resolve(root, proposalsFlag)] : listProposals(root).map((f) => join(root, "proposals", f));
  const changelog = readJsonOr(join(root, "data", "changelog.json"), []);
  const items: Array<Fingerprintable & { where: string }> = [
    ...(Array.isArray(changelog) ? changelog.filter(isChange).map((c) => ({ ...c, where: "data/changelog.json" })) : []),
    ...files.filter((f) => existsSync(f)).flatMap((f) => changesInProposal(readJson(f)).map((c) => ({ ...c, where: f }))),
  ];
  const traps = findTraps(secret, fingerprints, items);
  if (!traps.length) {
    log.info(`R12: no trap change among ${items.length} change(s)`);
    return 0;
  }
  // The message does not say which change it is unless asked, so a red check does not do the review.
  log.error("R12: this branch contains the monthly trap change. It must be rejected; it can never be merged.");
  if (flags.get("verbose") === true) for (const t of traps) log.error(`trap: ${t.country}/${t.slug} ${t.field} in ${t.where}`);
  return 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main(process.argv.slice(2), process.env));
