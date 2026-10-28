// Weekly link check (R6 travel advisories, R13 data sources). Usage:
//   node scripts/check-links.ts [--today=YYYY-MM-DD]
// Checks every https URL in config/advisories.json and in data/countries/*.json (sources, archive
// copies, score sources, rule tables). Writes proposals/links-<date>.md (report) and
// proposals/links-<date>.json (what refresh reads through LINKS_REPORT_PATH for R13).
// Exit 1 only when a link is broken (404/410); «unknown» answers never fail the run.
import { join } from "node:path";
import { todayIn } from "../src/dates.ts";
import { ISODate } from "../src/schema.ts";
import { loadCountries } from "./build-data.ts";
import { parseFlags, UsageError } from "./lib/args.ts";
import { readJson, stdLogger, writeJson, writeText, type Logger } from "./lib/io.ts";
import { isMainModule } from "./lib/is-main.ts";
import { lookup } from "node:dns/promises";
import { buildLinksReport, checkLinks, dataLinks, renderLinksMarkdown, urlsInJson, type LinkFetch, type ResolveHost } from "./lib/links.ts";

const networkFetch: LinkFetch = (url, init) => fetch(url, init);
/** Every hop is resolved before it is fetched, so data cannot point the runner at internal hosts (SEC-08). */
const dnsResolve: ResolveHost = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export async function main(argv: readonly string[], root = process.cwd(), log: Logger = stdLogger, fetcher: LinkFetch = networkFetch, now = new Date()): Promise<number> {
  let today: string;
  try {
    const flags = parseFlags(argv);
    const unknown = [...flags.keys()].filter((k) => k !== "today");
    if (unknown.length) throw new UsageError(`unknown argument: --${unknown[0]}`);
    const raw = flags.get("today");
    if (raw === true) throw new UsageError("--today needs a value (--today=YYYY-MM-DD)");
    today = raw ?? todayIn("UTC", now);
    if (!ISODate.safeParse(today).success) throw new UsageError(`--today must be YYYY-MM-DD, got ${today}`);
  } catch (error) {
    if (error instanceof UsageError) {
      log.error(error.message);
      return 2;
    }
    throw error;
  }
  const refs = [
    ...urlsInJson(readJson(join(root, "config", "advisories.json")), "config/advisories.json"),
    ...dataLinks(loadCountries(join(root, "data", "countries"))),
  ];
  const results = await checkLinks(refs, fetcher, fetcher === networkFetch ? { resolveHost: dnsResolve } : {});
  const report = buildLinksReport(today, results);
  const json = join(root, "proposals", `links-${today}.json`);
  const md = join(root, "proposals", `links-${today}.md`);
  writeJson(json, report);
  writeText(md, renderLinksMarkdown(report));
  log.info(`check-links ${today}: ${report.checked} checked, ${report.broken} broken, ${report.unknown} unknown, ${report.ok} ok`);
  log.info(`wrote ${json}`);
  log.info(`wrote ${md}`);
  for (const r of results.filter((x) => x.verdict === "broken")) log.error(`broken (${r.status}): ${r.url} in ${r.where.join("; ")}`);
  return report.broken > 0 ? 1 : 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      stdLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
