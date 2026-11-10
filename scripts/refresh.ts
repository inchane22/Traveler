// One verification or news sweep (H4, R9) by hand; pipeline.ts runs them on a schedule. Usage:
//   pnpm refresh -- [--dry-run] [--only=<slug>] [--country=<cc>] [--today=YYYY-MM-DD] [--fixtures=<dir>]
//                   [--sweep=news [--within=<days>]] [--classify]
// Env beyond the API ones: LINKS_REPORT_PATH (proposals/links-<date>.json from check-links, R13)
// and MAX_FOLLOWUPS_PER_RUN (wider follow-up searches for missing dates; 6 by default, 0 = off).
// Every call is appended to data/state/ledger.jsonl (R10), dry runs included: they spend too.
// Locally the key comes from 1Password: op run --env-file=.env.op -- pnpm refresh -- --dry-run
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { refreshArgs, UsageError } from "./lib/args.ts";
import { archiverFor } from "./lib/archive.ts";
import { usageStoreFor } from "./lib/budget-store.ts";
import { anthropicTransport, fixtureDirTransport } from "./lib/client.ts";
import { readJson, stdLogger, type Logger } from "./lib/io.ts";
import { readLinksReport } from "./lib/links.ts";
import { runRefresh } from "./lib/refresh-run.ts";
import { isMainModule } from "./lib/is-main.ts";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, root = process.cwd(), log: Logger = stdLogger): Promise<number> {
  let args;
  try {
    args = refreshArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      log.error(error.message);
      return 2;
    }
    throw error;
  }
  const offline = args.fixtures !== null;
  const usage = usageStoreFor(root, offline);
  const links = readLinksReport(env.LINKS_REPORT_PATH, args.today, { read: readJson, exists: existsSync }, log);
  const result = await runRefresh(
    {
      root,
      dryRun: args.dryRun,
      today: args.today,
      model: args.model,
      ...(args.only ? { only: args.only } : {}),
      ...(args.country ? { country: args.country } : {}),
      maxFestivals: args.maxFestivals,
      perCountry: args.perCountry,
      maxFollowups: args.maxFollowups,
      budgetUsd: args.budgetUsd,
      ...(args.githubOutput ? { githubOutput: args.githubOutput } : {}),
      ...(args.sweepWithin !== undefined ? { sweepWithin: args.sweepWithin } : {}),
      ...(args.classify ? { classify: true } : {}),
      ...(links ? { links } : {}),
    },
    {
      transport: offline ? fixtureDirTransport(resolve(root, args.fixtures!)) : anthropicTransport(),
      archiver: archiverFor(env, { dryRun: args.dryRun, offline, log }),
      usage,
      log,
    },
  );
  for (const file of result.files) log.info(`wrote ${file}`);
  return result.exitCode;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      stdLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
