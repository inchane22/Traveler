// Weekly verification (H4, RF-15). Usage, from docs/architecture.md:
//   pnpm refresh -- [--dry-run] [--only=<slug>] [--country=<cc>] [--today=YYYY-MM-DD] [--fixtures=<dir>]
// Locally the key comes from 1Password: op run --env-file=.env.op -- pnpm refresh -- --dry-run
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { refreshArgs, UsageError } from "./lib/args.ts";
import { archiverFor } from "./lib/archive.ts";
import { fileUsageStore, memoryUsageStore, UsageFile } from "./lib/budget.ts";
import { anthropicTransport, fixtureDirTransport } from "./lib/client.ts";
import { readJson, readJsonOr, stdLogger, writeJson, type Logger } from "./lib/io.ts";
import { runRefresh } from "./lib/refresh-run.ts";

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
  const usagePath = join(root, "data", "usage.json");
  // Recorded responses cost nothing, so a fixture run never touches data/usage.json.
  const usage = offline
    ? memoryUsageStore(UsageFile.parse(readJsonOr(usagePath, [])))
    : fileUsageStore(usagePath, { read: readJson, write: writeJson, exists: existsSync });
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
      budgetUsd: args.budgetUsd,
      ...(args.trapSecret ? { trapSecret: args.trapSecret } : {}),
      ...(args.githubOutput ? { githubOutput: args.githubOutput } : {}),
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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      stdLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
