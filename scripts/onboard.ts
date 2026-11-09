// Country onboarding by hand (H5); pipeline.ts runs it when a country is requested. Usage:
//   pnpm onboard -- --country=<cc> [--dry-run] [--today=YYYY-MM-DD] [--fixtures=<dir>]
// Writes data/countries/<cc>.json as «borrador» (never over an existing file) and a summary in
// proposals/onboard-<cc>-<date>.md; with --dry-run only the proposals files.
import { resolve } from "node:path";
import { onboardArgs, UsageError } from "./lib/args.ts";
import { usageStoreFor } from "./lib/budget-store.ts";
import { archiverFor } from "./lib/archive.ts";
import { anthropicTransport, fixtureDirTransport } from "./lib/client.ts";
import { stdLogger, type Logger } from "./lib/io.ts";
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
  const usage = usageStoreFor(root, offline);
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
    { transport: offline ? fixtureDirTransport(resolve(root, args.fixtures!)) : anthropicTransport(), usage, log, archiver: archiverFor(env, { dryRun: args.dryRun, offline, log }) },
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
