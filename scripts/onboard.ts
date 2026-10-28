// Monthly country onboarding (H5). Usage, from docs/architecture.md:
//   pnpm onboard -- --country=<cc> [--dry-run] [--today=YYYY-MM-DD] [--fixtures=<dir>]
// Writes data/countries/<cc>.json as «borrador» (never over an existing file) and the PR body in
// proposals/onboard-<cc>-<date>.md; with --dry-run only the proposals files.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { onboardArgs, UsageError } from "./lib/args.ts";
import { fileUsageStore, memoryUsageStore, readUsageFallback, UsageFile, withUsageFallback } from "./lib/budget.ts";
import { anthropicTransport, fixtureDirTransport } from "./lib/client.ts";
import { readJson, readJsonOr, stdLogger, writeJson, type Logger } from "./lib/io.ts";
import { runOnboard } from "./lib/onboard-run.ts";
import { isMainModule } from "./lib/is-main.ts";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, root = process.cwd(), log: Logger = stdLogger): Promise<number> {
  let args;
  try {
    args = onboardArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      log.error(error.message);
      return 2;
    }
    throw error;
  }
  const offline = args.fixtures !== null;
  const usagePath = join(root, "data", "usage.json");
  const base = offline
    ? memoryUsageStore(UsageFile.parse(readJsonOr(usagePath, [])))
    : fileUsageStore(usagePath, { read: readJson, write: writeJson, exists: existsSync });
  // Same budget as refresh: the last run artifact's usage.json counts too (USAGE_FALLBACK_PATH).
  const fallback = readUsageFallback(env.USAGE_FALLBACK_PATH, { read: readJson, exists: existsSync }, log);
  const usage = withUsageFallback(base, fallback, { persist: !offline, log });
  const result = await runOnboard(
    {
      root,
      country: args.country,
      dryRun: args.dryRun,
      today: args.today,
      model: args.model,
      budgetUsd: args.budgetUsd,
      ...(args.githubOutput ? { githubOutput: args.githubOutput } : {}),
    },
    { transport: offline ? fixtureDirTransport(resolve(root, args.fixtures!)) : anthropicTransport(), usage, log },
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
