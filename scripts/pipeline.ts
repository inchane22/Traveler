// The daily pipeline (pipeline.yml), also runnable by hand. Usage, from docs/architecture.md:
//   pnpm pipeline -- [--plan] [--request=<cc> [--issue=<n>]] [--today=YYYY-MM-DD] [--fixtures=<dir>]
// --plan (or --dry-run) prints today's plan without any API call. Env beyond the API ones:
// MONTHLY_BUDGET_USD, MAX_FESTIVALS_PER_RUN, MAX_FOLLOWUPS_PER_RUN, LINKS_REPORT_PATH (R13),
// SITE_URL, and ISSUE_NUMBER / ISSUE_TITLE / ISSUE_BODY when a «build-country» issue started it.
// Every API call is appended to data/state/ledger.jsonl (fixture runs keep it in memory).
// Locally the key comes from 1Password: op run --env-file=.env.op -- pnpm pipeline -- --plan
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pipelineArgs, UsageError } from "./lib/args.ts";
import { archiverFor } from "./lib/archive.ts";
import { ledgerUsageStore, memoryUsageStore } from "./lib/budget.ts";
import { anthropicTransport, fixtureDirTransport } from "./lib/client.ts";
import { readJson, stdLogger, type Logger } from "./lib/io.ts";
import { isMainModule } from "./lib/is-main.ts";
import { ledgerPath, monthsOf, readLedger } from "./lib/ledger.ts";
import { readLinksReport } from "./lib/links.ts";
import { runPipeline, spendLine } from "./lib/pipeline-run.ts";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, root = process.cwd(), log: Logger = stdLogger): Promise<number> {
  let args;
  try {
    args = pipelineArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      log.error(error.message);
      return 2;
    }
    throw error;
  }
  const offline = args.fixtures !== null;
  const path = ledgerPath(root);
  const memory = offline ? memoryUsageStore(monthsOf(readLedger(path))) : null;
  const usage = memory ?? ledgerUsageStore(path);
  const ledger = () => [...readLedger(path), ...(memory?.entries ?? [])];
  log.info(spendLine(ledger(), args.today.slice(0, 7), args.budgetUsd));
  const links = readLinksReport(env.LINKS_REPORT_PATH, args.today, { read: readJson, exists: existsSync }, log);
  const result = await runPipeline(
    {
      root,
      today: args.today,
      model: args.model,
      budgetUsd: args.budgetUsd,
      maxFestivals: args.maxFestivals,
      maxFollowups: args.maxFollowups,
      planOnly: args.planOnly,
      ...(args.request ? { request: args.request } : {}),
      ...(links ? { links } : {}),
      ...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
      ...(args.githubOutput ? { githubOutput: args.githubOutput } : {}),
    },
    {
      transport: offline ? fixtureDirTransport(resolve(root, args.fixtures!)) : anthropicTransport(),
      archiver: archiverFor(env, { dryRun: args.planOnly, offline, log }),
      usage,
      ledger,
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
