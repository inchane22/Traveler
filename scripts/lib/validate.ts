// Code-side validation of every proposed change before it can reach a PR (PRD «Validación en código»
// plus the R1, R2, R3, R7 controls of the risk register, which win where they differ). Pure.
import { addDays, resolveRule, type DateWindow, type RuleContext } from "../../src/dates.ts";
import { Confidence, ISODate, Proposal, Status, type Festival, type Lang } from "../../src/schema.ts";
import type { Tier } from "../../src/score.ts";
import { quoteStatesDate, type DateRole } from "./date-parser.ts";
import type { DomainPolicy } from "./domains.ts";
import { checkSources, citedTextsFor, meetsTier1SourceRule, quoteIsVerbatim, quoteNumbers, quoteYears, type CitedSource } from "./evidence.ts";
import { hasInjection } from "./injection.ts";
import { isSupportedLang, primaryLang, quoteSupportsStatus } from "./lang.ts";
import type { Citation } from "./research.ts";

export type Verdict = "accepted" | "flagged" | "rejected";
export type ChangeValue = string | number | null;

export interface ReviewedChange {
  country: string;
  slug: string;
  name: string;
  tier: Tier;
  year: number;
  daysToStart: number;
  field: string;
  old: ChangeValue;
  new: ChangeValue;
  kind: "change" | "confirmation";
  sources: CitedSource[];
  /** The cited source whose text contains the quote. */
  quote_url: string | null;
  quote: string;
  quote_language: string;
  proposed_confidence: Confidence;
  confidence: Confidence;
  note: string;
  verdict: Verdict;
  /** Why a human must look (flagged) — never auto-applied. */
  flags: string[];
  /** Why it was rejected. */
  reasons: string[];
  /** Adjustments code made (confidence cap, corrected `old`). */
  adjustments: string[];
  risk: number;
}

export interface ReviewContext {
  country: string;
  festival: Festival;
  tier: Tier;
  year: number;
  daysToStart: number;
  citations: readonly Citation[];
  policy: DomainPolicy;
  ruleCtx: RuleContext;
}

export const WINDOW_MARGIN_DAYS = 30;
const SCORE_LEVELS: Record<string, readonly string[]> = {
  calle: ["mayoria_gratis", "mixta", "mayoria_boleta"],
  reconocimiento: ["unesco", "nacional", "ninguna"],
  conectividad: ["internacional", "nacional", "ninguno"],
  local: ["pueblo", "intermedia", "gran_ciudad"],
};
const DATE_FIELDS = new Set(["start", "end"]);

export const isDateField = (field: string): boolean => DATE_FIELDS.has(field) || field.startsWith("key_events.");
export const keyEventId = (field: string): string => field.slice("key_events.".length).replace(/_/g, "-");

/** Value stored today for a whitelisted field (null when there is none). */
export function currentValue(festival: Festival, year: number, field: string): ChangeValue {
  const edition = festival.editions[String(year)];
  if (field === "start" || field === "end" || field === "status" || field === "confidence") return edition?.[field] ?? null;
  if (field.startsWith("key_events.")) return edition?.key_events.find((k) => k.id === keyEventId(field))?.date ?? null;
  const criterion = field.slice("score.".length) as keyof Festival["score"];
  const measured = festival.score[criterion];
  if (!measured) return null;
  return typeof measured.measure === "object" ? measured.measure.attendance : measured.measure;
}

/** Rule window for the edition year, widened by the margin; null when the rule gives no edition. */
export function ruleWindow(festival: Festival, year: number, ctx: RuleContext): DateWindow | null {
  const resolved = resolveRule(festival.rule, year, ctx);
  if (!resolved) return null;
  const w = resolved.kind === "window" ? resolved.window : { start: resolved.start, end: resolved.end };
  return { start: addDays(w.start, -WINDOW_MARGIN_DAYS), end: addDays(w.end, WINDOW_MARGIN_DAYS) };
}

/** Field whitelist (schema regex) plus the criteria that exist; anything else is unknown (R7, LLM05). */
export function fieldProblem(field: string): string | null {
  if (!/^(start|end|status|confidence|key_events\.[a-z0-9_-]+|score\.[a-z]+)$/.test(field)) return `campo no permitido: ${field}`;
  if (field.startsWith("score.") && !["convocatoria", ...Object.keys(SCORE_LEVELS)].includes(field.slice(6))) return `criterio desconocido: ${field}`;
  return null;
}

export function valueProblem(field: string, value: ChangeValue): string | null {
  if (value === null) return "no se borran datos: el valor nuevo es nulo";
  if (isDateField(field)) return ISODate.safeParse(value).success ? null : `fecha inválida: ${value}`;
  if (field === "status") return Status.safeParse(value).success ? null : `estado inválido: ${value}`;
  if (field === "confidence") return Confidence.safeParse(value).success ? null : `confianza inválida: ${value}`;
  if (field === "score.convocatoria") return Number.isInteger(Number(value)) && Number(value) >= 0 ? null : `cifra inválida: ${value}`;
  const levels = SCORE_LEVELS[field.slice(6)] ?? [];
  return levels.includes(String(value)) ? null : `valor inválido para ${field}: ${value}`;
}

function roleOf(field: string): DateRole {
  return field === "start" ? "start" : field === "end" ? "end" : "any";
}

const CONF_RANK: Record<Confidence, number> = { oficial: 3, prensa: 2, patron: 1, estimacion: 0 };
export const capConfidence = (c: Confidence, max: Confidence): Confidence => (CONF_RANK[c] > CONF_RANK[max] ? max : c);

/** R12: higher means riskier; tier-1 dates first. */
export function riskOf(field: string, tier: Tier, daysToStart: number, movesConfirmed: boolean): number {
  const isTier1 = tier === 1;
  let base = 20;
  if (DATE_FIELDS.has(field)) base = isTier1 ? 100 : 70;
  else if (field === "status") base = isTier1 ? 90 : 65;
  else if (field.startsWith("key_events.")) base = isTier1 ? 60 : 50;
  else if (field === "confidence") base = 40;
  else if (field.startsWith("score.")) base = 30;
  return base + (movesConfirmed ? 10 : 0) + (daysToStart <= 60 ? 5 : 0);
}

interface Proposed {
  field: string;
  old: ChangeValue;
  new: ChangeValue;
  source_urls: string[];
  quote: string;
  quote_language: string;
  confidence: Confidence;
  note: string;
}

/**
 * The evidence a status move needs, on top of the checks every change gets (a cited https source,
 * a literal quote, the Nivel 1 source rule). The lifecycle itself is in src/status.ts; «confirmada»
 * also needs start, end and a source on the resulting edition, which only the whole proposal can
 * tell (checkConfirmedStatus). `from` is the stored edition's status, undefined for a rule-only one.
 */
export function statusMoveCheck(from: Status | undefined, to: Status, quote: string): { reasons: string[]; flags: string[] } {
  const reasons: string[] = [];
  const flags: string[] = [];
  if (from === "confirmada" && (to === "tentativa" || to === "por_anunciar") && !quoteSupportsStatus(quote, "tentativa")) {
    reasons.push("una fecha confirmada no vuelve a tentativa sin una fuente que lo diga");
  }
  if ((to === "cancelada" || to === "aplazada") && !quoteSupportsStatus(quote, to)) flags.push(`revisar: la cita no dice ${to}`);
  // A page from before the cancellation reads just like the festival coming back: a person decides.
  if (from === "cancelada") flags.push("revisar: la edición estaba cancelada; una persona confirma que vuelve");
  return { reasons, flags };
}

/** Validates one change in isolation. Cross-field checks (start ≤ end) run in reviewProposal. */
export function reviewChange(change: Proposed, ctx: ReviewContext): ReviewedChange {
  const { festival, year, tier } = ctx;
  const flags: string[] = [];
  const reasons: string[] = [];
  const adjustments: string[] = [];
  const stored = festival.editions[String(year)];
  const old = fieldProblem(change.field) ? null : currentValue(festival, year, change.field);
  if (change.old !== old) adjustments.push(`valor anterior corregido con los datos aprobados (${String(old)})`);
  const value = change.field === "score.convocatoria" && change.new !== null ? Number(change.new) : change.new;
  const kind = value !== null && value === old ? "confirmation" : "change";

  const fieldIssue = fieldProblem(change.field) ?? valueProblem(change.field, value);
  if (fieldIssue) reasons.push(fieldIssue);

  // Sources: https, really cited by the search, not blocked (R1, R2, R7).
  const check = checkSources(change.source_urls, ctx.citations, ctx.policy);
  if (check.blocked.length) adjustments.push(`fuentes bloqueadas descartadas: ${check.blocked.join(", ")}`);
  if (check.notCited.length) adjustments.push(`URLs que no aparecen en las citas descartadas: ${check.notCited.join(", ")}`);
  if (check.notHttps.length) adjustments.push(`URLs no https descartadas: ${check.notHttps.join(", ")}`);
  if (!check.cited.length) reasons.push(check.blocked.length ? "solo fuentes de dominios bloqueados" : "sin fuente: ninguna URL https coincide con las citas de la búsqueda");

  const citedTexts = citedTextsFor(check.cited, ctx.citations);
  const quoteSource = check.cited.find((s) => quoteIsVerbatim(change.quote, citedTextsFor([s], ctx.citations))) ?? null;
  if (check.cited.length && !quoteSource) reasons.push("la cita no aparece literal en el texto citado (R1)");

  // R7: instruction phrases in anything that reaches the reviewer or the model.
  const hits = hasInjection([change.quote, change.note, ...citedTexts]);
  if (hits.length) flags.push(`inyección: posible instrucción en la fuente («${hits.map((h) => h.phrase).join("», «")}»)`);

  // R3: the quote must state the extracted date in its own language.
  if (!fieldIssue && isDateField(change.field) && typeof value === "string") {
    const lang = primaryLang(change.quote_language);
    if (!isSupportedLang(lang)) flags.push(`revisar idioma: sin lector de fechas para «${change.quote_language}»`);
    else if (!quoteStatesDate(change.quote, lang as Lang, value, roleOf(change.field))) flags.push("revisar idioma: la fecha de la cita no coincide con la extraída");
  }

  // Rule window ±30 días; out of window blocks tier-1 dates (R1) and flags the rest.
  if (!fieldIssue && isDateField(change.field) && typeof value === "string" && kind === "change") {
    const window = ruleWindow(festival, year, ctx.ruleCtx);
    if (!window) flags.push(`revisar: la regla no da fechas para ${year}`);
    else if (value < window.start || value > window.end) {
      const text = `fuera de la ventana de la regla (${window.start} a ${window.end})`;
      if (tier === 1 && DATE_FIELDS.has(change.field)) reasons.push(`${text}: bloqueado en Nivel 1`);
      else flags.push(`revisar: ${text}`);
    }
  }

  // Status moves must be backed by what the source says.
  const storedStatus = stored?.status;
  const target = Status.safeParse(value);
  if (change.field === "status" && target.success && kind === "change") {
    const move = statusMoveCheck(storedStatus, target.data, change.quote);
    reasons.push(...move.reasons);
    flags.push(...move.flags);
  }

  // R1/R2: tier-1 date and status changes need one A source or two B sources on different domains.
  if (tier === 1 && kind === "change" && (DATE_FIELDS.has(change.field) || change.field === "status") && check.cited.length && !meetsTier1SourceRule(check.cited)) {
    reasons.push("Nivel 1 exige una fuente A o dos fuentes B de dominios distintos");
  }

  if (change.field.startsWith("key_events.") && old === null && !stored?.key_events.some((k) => k.id === keyEventId(change.field))) {
    flags.push("revisar: evento clave nuevo, falta su nombre");
  }
  if (change.field === "score.convocatoria" && typeof value === "number") {
    if (kind === "change" && !quoteNumbers(change.quote).includes(value)) flags.push("revisar: la cifra no aparece en la cita");
    // A figure with no year cannot be «el último balance», confirmed or not (SEC-01).
    if (!quoteYears(change.quote).length) flags.push("revisar: la cifra no dice de qué año es");
  }
  if (["score.calle", "score.conectividad", "score.local"].includes(change.field) && kind === "change") flags.push("revisar: criterio de juicio, lo decide una persona");
  if (change.field === "score.reconocimiento" && kind === "change") {
    const needs = value === "unesco" ? /unesco|inmaterial|intangible|imaterial/i : /patrimonio|heritage|declarad|declarat/i;
    if (value !== "ninguna" && !needs.test(change.quote)) flags.push("revisar: la cita no menciona la declaratoria");
  }

  // Caps are measured on the source apply will store, so they agree with build-data's checks
  // (BE-01): a score keeps one (the one holding the quote, else the first cited); an edition keeps
  // every cited source. «oficial» needs an official domain; otherwise at most «prensa».
  const isScore = change.field.startsWith("score.");
  const storedSource = quoteSource ?? check.cited[0];
  const official = isScore ? !!storedSource?.official : check.cited.some((s) => s.official);
  let confidence = change.confidence;
  if (!official && change.confidence === "oficial") {
    confidence = "prensa";
    adjustments.push("confianza limitada a «prensa»: ninguna fuente guardada está en los dominios oficiales");
  }
  // A score figure on «prensa» needs an A or B source; a tier-C one is at most «estimacion».
  if (isScore && confidence === "prensa" && storedSource?.tier === "C") {
    confidence = "estimacion";
    adjustments.push("confianza limitada a «estimacion»: la fuente de la cita es de nivel C");
  }
  const finalValue = change.field === "confidence" && value === "oficial" && !official ? "prensa" : value;
  if (finalValue !== value) adjustments.push("«oficial» rebajado a «prensa»: ninguna fuente está en los dominios oficiales");

  const movesConfirmed = storedStatus === "confirmada" && kind === "change" && (DATE_FIELDS.has(change.field) || change.field === "status");
  return {
    country: ctx.country,
    slug: festival.slug,
    name: festival.names.es,
    tier,
    year,
    daysToStart: ctx.daysToStart,
    field: change.field,
    old,
    new: finalValue,
    kind: finalValue !== null && finalValue === old ? "confirmation" : "change",
    sources: check.cited,
    quote_url: quoteSource?.url ?? null,
    quote: change.quote,
    quote_language: change.quote_language,
    proposed_confidence: change.confidence,
    confidence,
    note: change.note,
    verdict: reasons.length ? "rejected" : flags.length ? "flagged" : "accepted",
    flags,
    reasons,
    adjustments,
    risk: riskOf(change.field, tier, ctx.daysToStart, movesConfirmed),
  };
}

export interface ProposalReview {
  changes: ReviewedChange[];
  /** Whole-proposal problems (wrong festival or edition, schema). */
  errors: string[];
  notFound: string[];
}

/** Validates a whole extraction result for the queued festival and edition. */
export function reviewProposal(raw: unknown, ctx: ReviewContext): ProposalReview {
  const parsed = Proposal.safeParse(raw);
  if (!parsed.success) return { changes: [], errors: [`esquema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`], notFound: [] };
  const p = parsed.data;
  const errors: string[] = [];
  if (p.country !== ctx.country) errors.push(`la propuesta es de otro país (${p.country})`);
  if (p.slug !== ctx.festival.slug) errors.push(`la propuesta es de otra fiesta (${p.slug})`);
  if (p.edition !== ctx.year) errors.push(`la propuesta es de otra edición (${p.edition}, se pidió ${ctx.year})`);
  if (errors.length) return { changes: [], errors, notFound: p.not_found };

  const reviewed = p.changes.map((c) => reviewChange(c, ctx));
  return { changes: checkConfirmedStatus(checkDateOrder(reviewed, ctx), ctx), errors, notFound: p.not_found };
}

/**
 * «confirmada» needs start, end and a source on the edition that results from the proposal (the
 * schema refuses anything else, and apply would throw on it). Otherwise the status move is rejected.
 */
export function checkConfirmedStatus(changes: readonly ReviewedChange[], ctx: ReviewContext): ReviewedChange[] {
  const edition = ctx.festival.editions[String(ctx.year)];
  const live = changes.filter((c) => c.verdict === "accepted");
  const pick = (field: "start" | "end"): ChangeValue => live.find((c) => c.field === field)?.new ?? edition?.[field] ?? null;
  // apply merges the sources of every edition change into the edition, the status change's own included.
  const hasSource = (edition?.sources.length ?? 0) > 0 || live.some((c) => !c.field.startsWith("score.") && c.sources.length > 0);
  const missing = [pick("start") === null ? "inicio" : null, pick("end") === null ? "fin" : null, hasSource ? null : "fuente"].filter(Boolean);
  if (!missing.length) return [...changes];
  return changes.map((c) =>
    c.field === "status" && c.new === "confirmada" && c.kind === "change" && c.verdict !== "rejected"
      ? { ...c, verdict: "rejected" as const, reasons: [...c.reasons, `«confirmada» sin ${missing.join(", ")} en la edición: no se confirma una fecha que no está`] }
      : c,
  );
}

/** start ≤ end for the edition after the proposal; both date changes are rejected otherwise. */
export function checkDateOrder(changes: readonly ReviewedChange[], ctx: ReviewContext): ReviewedChange[] {
  const edition = ctx.festival.editions[String(ctx.year)];
  const pick = (field: "start" | "end"): ChangeValue =>
    changes.find((c) => c.field === field && c.verdict !== "rejected")?.new ?? edition?.[field] ?? null;
  const start = pick("start");
  const end = pick("end");
  if (typeof start !== "string" || typeof end !== "string" || start <= end) return [...changes];
  return changes.map((c) =>
    DATE_FIELDS.has(c.field) && c.verdict !== "rejected"
      ? { ...c, verdict: "rejected" as const, reasons: [...c.reasons, `el inicio (${start}) queda después del fin (${end})`] }
      : c,
  );
}
