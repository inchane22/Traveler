// Country onboarding (H5, R2, R11): one research call, one extraction to OnboardingDraft, then code
// maps it onto the schema, scores it and writes a «borrador» country file plus a run summary. The
// pipeline (pipeline-run.ts) dates it further and publishes it once it passes the R2 gate.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addMonths } from "../../src/dates.ts";
import { CountryFile, MIN_SOURCED_FESTIVALS, type CountryFile as Country } from "../../src/schema.ts";
import { isParty, scoreFestival, type ScoringConfig } from "../../src/score.ts";
import { archiveAll, noopArchiver, type Archiver } from "./archive.ts";
import { BudgetExceededError, createBudgetGuard, type UsageStore } from "./budget.ts";
import { classifyApiError, type MessagesTransport } from "./client.ts";
import { loadDomainPolicy, withGovernmentFallback } from "./domains.ts";
import { extract } from "./extract.ts";
import { appendGithubOutput, loadPrompt, readJson, writeJson, writeText, type Logger } from "./io.ts";
import { countryInfo } from "./lang.ts";
import { details, mdLink, mdTable, mdText } from "./markdown.ts";
import { mapFestival, OnboardingDraft, type MappedFestival } from "./onboard-draft.ts";
import { research } from "./research.ts";
import { loadSensitiveTerms, sensitiveHits } from "./sensitive.ts";

export interface OnboardOptions {
  root: string;
  country: string;
  dryRun: boolean;
  today: string;
  model: string;
  budgetUsd: number;
  githubOutput?: string;
}

export interface OnboardDeps {
  transport: MessagesTransport;
  usage: UsageStore;
  log: Logger;
  /** R13: cited edition sources are archived before the draft is written (none in a dry run). */
  archiver?: Archiver;
}

/** Edition sources with the archive copy made for them; the same object when nothing was archived. */
export function withArchives(country: Country, archived: ReadonlyMap<string, string>): Country {
  if (!archived.size) return country;
  return {
    ...country,
    festivals: country.festivals.map((f) => ({
      ...f,
      editions: Object.fromEntries(
        Object.entries(f.editions).map(([y, e]) => [y, { ...e, sources: e.sources.map((s) => (archived.has(s.url) && !s.archive_url ? { ...s, archive_url: archived.get(s.url)! } : s)) }]),
      ),
    })),
  };
}

export const ONBOARD_MAX_USES = 15;
/** Re-exported from src/schema.ts so build-data and onboarding share one threshold. */
export { MIN_SOURCED_FESTIVALS };
export const MIN_SHARE_A = 0.6;
export const MIN_NON_MEDIA_SHARE = 0.5;

export interface OnboardFlags {
  /** Festivals with at least one validated A or B source. */
  sourced: number;
  shareA: number;
  nonMediaShare: number;
  messages: string[];
}

export interface OnboardReport {
  kind: "onboard";
  date: string;
  country: string;
  model: string;
  dry_run: boolean;
  flags: OnboardFlags;
  festivals: Array<{ slug: string; name: string; city: string; tier: string; low: number; high: number; verified: string[]; por_medir: string[]; sources: string[] }>;
  dropped: string[];
  not_found: string[];
}

/** R2 + R11 flags over the mapped festivals (ranked best first). A solemn act counts toward neither. */
export function onboardFlags(all: readonly MappedFestival[], allRanked: readonly MappedFestival[]): OnboardFlags {
  const messages: string[] = [];
  const mapped = all.filter((m) => isParty(m.festival.score));
  const ranked = allRanked.filter((m) => isParty(m.festival.score));
  const sourced = mapped.filter((m) => m.sources.some((s) => s.tier === "A" || s.tier === "B")).length;
  const dated = mapped.filter((m) => m.datedEdition);
  const withA = dated.filter((m) => Object.values(m.festival.editions).some((e) => e.sources.some((s) => s.tier === "A")));
  const shareA = dated.length ? withA.length / dated.length : 0;
  const nonMedia = mapped.filter((m) => ["unesco", "cultura_turismo", "feriados"].includes(m.candidateSource)).length;
  const nonMediaShare = mapped.length ? nonMedia / mapped.length : 0;
  if (sourced < MIN_SOURCED_FESTIVALS) messages.push(`R2: solo ${sourced} fiesta(s) con fuente A o B; el país queda en borrador hasta tener ${MIN_SOURCED_FESTIVALS}`);
  if (shareA < MIN_SHARE_A) messages.push(`R2: cobertura parcial: ${Math.round(shareA * 100)}% de las fechas con fuente A (mínimo ${MIN_SHARE_A * 100}%)`);
  if (nonMediaShare < MIN_NON_MEDIA_SHARE) messages.push(`R11: solo ${Math.round(nonMediaShare * 100)}% de las candidatas viene de fuentes no mediáticas`);
  const top = ranked.slice(0, 5);
  if (top.length >= 2 && new Set(top.map((m) => m.festival.city)).size === 1) messages.push(`R11: alerta: las ${top.length} mejores están en ${top[0]!.festival.city}`);
  return { sourced, shareA: Math.round(shareA * 100) / 100, nonMediaShare: Math.round(nonMediaShare * 100) / 100, messages };
}

export function renderOnboardMarkdown(r: OnboardReport): string {
  const rows = r.festivals.map((f) => [
    mdText(f.name, 60),
    mdText(f.city, 40),
    f.low === f.high ? String(f.low) : `${f.low} a ${f.high}`,
    mdText(f.tier),
    f.verified.length ? mdText(f.verified.join(", ")) : "—",
    f.por_medir.length ? mdText(f.por_medir.join(", ")) : "—",
    f.sources.length ? f.sources.map((u, i) => mdLink(`[${i + 1}]`, u)).join(" ") : "—",
  ]);
  const parts = [
    `## Onboarding ${r.country} (${r.date})`,
    `Borrador generado por la IA y validado en código. El país se publica solo cuando tiene al menos ${MIN_SOURCED_FESTIVALS} fiestas con fecha y fuente A o B. Lo que no tiene cita validada queda «por medir» o «por anunciar». Modelo: \`${mdText(r.model, 40)}\`${r.dry_run ? " · ensayo (--dry-run)" : ""}.`,
    r.flags.messages.length ? r.flags.messages.map((m) => `> **${mdText(m, 200)}**`).join("\n>\n") : "Sin alertas de cobertura.",
    mdTable(["Fiesta", "Ciudad", "Puntaje", "Nivel", "Verificado", "Por medir", "Fuentes"], rows),
  ];
  if (r.dropped.length) parts.push(details(`Descartadas (${r.dropped.length})`, r.dropped.map((d) => `- ${mdText(d, 200)}`).join("\n")));
  if (r.not_found.length) parts.push(details("No encontrado", r.not_found.map((d) => `- ${mdText(d, 120)}`).join("\n")));
  return `${parts.join("\n\n")}\n`;
}

export async function runOnboard(opts: OnboardOptions, deps: OnboardDeps): Promise<{ exitCode: number; files: string[]; draft: Country | null; report: OnboardReport | null }> {
  const fail = (message: string) => {
    deps.log.error(message);
    return { exitCode: 1, files: [], draft: null, report: null };
  };
  const cc = opts.country.toUpperCase();
  const info = countryInfo(cc);
  if (!info) return fail(`onboard ${cc}: no country facts in scripts/lib/lang.ts (timezone, region, language); add them first`);
  const dataPath = join(opts.root, "data", "countries", `${cc.toLowerCase()}.json`);
  if (!opts.dryRun && existsSync(dataPath)) return fail(`onboard ${cc}: ${dataPath} already exists; refresh verifies it, onboarding never overwrites a country`);
  const config = readJson(join(opts.root, "config", "scoring.json")) as ScoringConfig;
  const policy = withGovernmentFallback(loadDomainPolicy(opts.root, cc));
  const guard = createBudgetGuard({ month: opts.today.slice(0, 7), today: opts.today, budgetUsd: opts.budgetUsd, model: opts.model, store: deps.usage, log: deps.log, job: "onboard" });
  const key = `onboard/${cc}`;

  let draft: OnboardingDraft;
  let citations;
  try {
    const result = await research(deps.transport, guard, {
      key,
      model: opts.model,
      system: loadPrompt("onboard-research-system.md"),
      user: loadPrompt("onboard-research-user.md", { country_name: info.names.en, country: cc, lang: info.local, today: opts.today, horizon: addMonths(opts.today, 12) }),
      country: cc,
      timezone: info.timezone,
      maxUses: ONBOARD_MAX_USES,
      allowedDomains: [],
      blockedDomains: policy.blocked,
    });
    if (result.outcome !== "ok") return fail(`onboard ${cc}: research ${result.outcome}${result.refusalCategory ? ` (${result.refusalCategory})` : ""}`);
    citations = result.citations;
    const extracted = await extract(deps.transport, guard, {
      key,
      model: opts.model,
      system: loadPrompt("onboard-extract-system.md"),
      context: `País: ${info.names.es} (${cc}). Zona por defecto: ${info.timezone}. Hoy: ${opts.today}.`,
      citations: result.citations,
      schema: OnboardingDraft,
      maxTokens: 16000,
    });
    if (!extracted.ok) return fail(`onboard ${cc}: extraction dropped after ${extracted.attempts} attempt(s): ${extracted.reason} ${extracted.detail}`);
    draft = extracted.value;
  } catch (error) {
    if (error instanceof BudgetExceededError) return fail(error.message);
    const failure = classifyApiError(error);
    return fail(`onboard ${cc}: ${failure.kind}: ${failure.message}`);
  }
  if (draft.country.toUpperCase() !== cc) return fail(`onboard ${cc}: the draft is for ${draft.country}`);

  const ctx = { citations, policy };
  const dropped: string[] = [];
  const mapped: MappedFestival[] = [];
  for (const f of draft.festivals.slice(0, 10)) {
    const m = mapFestival(f, cc, info.timezone, ctx, opts.today);
    if ("error" in m) dropped.push(m.error);
    else if (mapped.some((x) => x.festival.slug === m.festival.slug)) dropped.push(`${m.festival.slug}: duplicate`);
    else mapped.push(m);
  }
  const scored = mapped.map((m) => ({ m, s: scoreFestival(m.festival.score, config) }));
  const ranked = [...scored].sort((a, b) => b.s.low - a.s.low || b.s.high - a.s.high || a.m.festival.slug.localeCompare(b.m.festival.slug));
  const base = onboardFlags(mapped, ranked.map((x) => x.m));
  const terms = loadSensitiveTerms(opts.root);
  const r5 = mapped.flatMap((m) => sensitiveHits(m.festival, terms)).map((h) => `R5: revisar el texto de ${h.slug} (${h.field}): «${h.term}» presenta la fiesta como simple parranda`);
  const flags = { ...base, messages: [...base.messages, ...r5] };

  const parsed = CountryFile.safeParse({ country: cc, status: "borrador", generated_at: opts.today, timezone: info.timezone, region: info.region, festivals: ranked.map((x) => x.m.festival) });
  if (!parsed.success) return fail(`onboard ${cc}: draft does not validate: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const report: OnboardReport = {
    kind: "onboard",
    date: opts.today,
    country: cc,
    model: opts.model,
    dry_run: opts.dryRun,
    flags,
    festivals: ranked.map(({ m, s }) => ({ slug: m.festival.slug, name: m.festival.names.es, city: m.festival.city, tier: String(s.tier), low: s.low, high: s.high, verified: m.verified, por_medir: m.porMedir, sources: [...new Set(m.sources.map((x) => x.url))] })),
    dropped,
    not_found: draft.not_found,
  };
  for (const m of flags.messages) deps.log.warn(m);
  if (!parsed.data.festivals.length) {
    appendGithubOutput(opts.githubOutput, { changes: 0 });
    return fail(`onboard ${cc}: no festival survived validation`);
  }

  const name = `onboard-${cc.toLowerCase()}-${opts.today}`;
  const files = [join(opts.root, "proposals", `${name}.json`), join(opts.root, "proposals", `${name}.md`)];
  writeJson(files[0]!, { ...report, draft: parsed.data });
  writeText(files[1]!, renderOnboardMarkdown(report));
  if (!opts.dryRun) {
    const urls = parsed.data.festivals.flatMap((f) => Object.values(f.editions).flatMap((e) => e.sources.map((s) => s.url)));
    const archived = await archiveAll(deps.archiver ?? noopArchiver, urls);
    deps.log.info(`R13: ${archived.size} of ${new Set(urls).size} edition source(s) archived`);
    writeJson(dataPath, CountryFile.parse(withArchives(parsed.data, archived)));
    files.push(dataPath);
  }
  appendGithubOutput(opts.githubOutput, { changes: parsed.data.festivals.length });
  deps.log.info(`onboard ${cc}: ${parsed.data.festivals.length} festival(s) in draft, ${dropped.length} dropped`);
  return { exitCode: 0, files, draft: parsed.data, report };
}
