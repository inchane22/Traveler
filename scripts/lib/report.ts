// proposals/<name>.json (everything the run decided, with reasons) and proposals/<name>.md (run summary).
import type { BudgetLevel } from "./budget.ts";
import type { LinkDowngrade } from "./links.ts";
import { details, mdLink, mdTable, mdText } from "./markdown.ts";
import type { QueueReason } from "./queue.ts";
import type { Selection } from "./select.ts";
import type { ReviewedChange } from "./validate.ts";

export type FestivalOutcome =
  | "ok"
  | "no_citations"
  | "refusal"
  | "truncated"
  | "invalid_proposal"
  | "api_error"
  | "error"
  | "no_fixture"
  | "skipped_budget"
  | "not_run";

export interface FestivalLog {
  country: string;
  slug: string;
  year: number;
  tier: string;
  days_to_start: number | null;
  reasons: QueueReason[];
  outcome: FestivalOutcome;
  pass?: 1 | 2;
  citations?: number;
  search_errors?: string[];
  detail?: string;
  /** Second, wider search for the facts the first pass cited pages for but did not state. */
  followup?: FollowupLog;
}

export interface FollowupLog {
  fields: string[];
  outcome: FestivalOutcome;
  citations?: number;
  /** Fields the follow-up proposed a value for that passed validation or went to review. */
  answered?: string[];
  detail?: string;
}

/** R2: a draft country goes live by itself once 3 festivals have a dated, A- or B-sourced edition. */
export interface DraftProgress {
  country: string;
  before: number;
  after: number;
  needed: number;
}

export interface RefreshReport {
  kind: "refresh";
  date: string;
  model: string;
  dry_run: boolean;
  stopped: string | null;
  budget: { month: string; usd: number; budget_usd: number; level: BudgetLevel; searches: number };
  festivals: FestivalLog[];
  applied: ReviewedChange[];
  confirmations: ReviewedChange[];
  flagged: ReviewedChange[];
  rejected: ReviewedChange[];
  not_found: Array<{ country: string; slug: string; fields: string[] }>;
  /** R9 news sweep: the day window (`--sweep=news --within`); absent on the weekly run. */
  sweep_within?: number;
  /** A classification run (`score.fiesta`, `score.viajeros`) rather than a verification. */
  classify?: true;
  /** R13: editions whose sources are all gone, one confidence level down (from LINKS_REPORT_PATH). */
  link_downgrades?: LinkDowngrade[];
  /** R2: draft countries this run researched, with their sourced festivals before and after it. */
  drafts?: DraftProgress[];
}

const FIELD_LABEL: Record<string, string> = { start: "inicio", end: "fin", status: "estado", confidence: "confianza" };
export const fieldLabel = (field: string): string => FIELD_LABEL[field] ?? field;
const isTier1Date = (c: ReviewedChange): boolean => c.tier === 1 && (c.field === "start" || c.field === "end" || c.field.startsWith("key_events."));

function sourceCell(c: ReviewedChange): string {
  if (!c.sources.length) return "—";
  return c.sources.map((s) => `${mdLink(s.domain, s.url)} (${s.tier})`).join(", ");
}

function marks(c: ReviewedChange): string {
  const all = [...c.flags, ...c.adjustments];
  return all.length ? all.map((m) => mdText(m, 160)).join("<br>") : "—";
}

function row(c: ReviewedChange): string[] {
  const hl = (s: string) => (isTier1Date(c) || (c.tier === 1 && c.field === "status") ? `**${s}**` : s);
  return [
    c.tier === 1 ? "**Nivel 1**" : mdText(String(c.tier)),
    c.country,
    hl(mdText(c.name, 60)),
    hl(mdText(fieldLabel(c.field))),
    mdText(c.old),
    hl(mdText(c.new)),
    sourceCell(c),
    mdText(c.confidence),
    marks(c),
  ];
}

const HEADER = ["Nivel", "País", "Fiesta", "Campo", "Antes", "Después", "Fuente", "Confianza", "Marcas"];

function quoteBlock(c: ReviewedChange): string {
  const where = c.quote_url ? mdLink("fuente", c.quote_url) : "sin fuente";
  return `- ${c.country} · ${mdText(c.name, 60)} · ${mdText(fieldLabel(c.field))} → \`${mdText(c.new, 40).replace(/`/g, "")}\`\n  > ${mdText(c.quote, 400)}\n  >\n  > idioma: ${mdText(c.quote_language, 8)} · ${where} · nota: ${mdText(c.note, 300)}`;
}

function draftLine(d: DraftProgress): string {
  const count = `${d.after} de ${d.needed} fiestas con fecha y fuente A o B${d.after === d.before ? "" : ` (antes ${d.before})`}`;
  if (d.after < d.needed) return `- ${d.country}: ${count}; sigue en borrador.`;
  return `- ${d.country}: ${count}. **Listo:** se publica solo al final de esta corrida.`;
}

function followupText(f: FollowupLog): string {
  const fields = f.fields.map(fieldLabel).join(", ");
  const found = f.answered?.length ? `, propuso ${f.answered.map(fieldLabel).join(", ")}` : "";
  const cites = f.citations !== undefined ? `, ${f.citations} citas` : "";
  return `búsqueda amplia para ${fields}: ${f.outcome}${cites}${found}${f.detail ? ` (${mdText(f.detail, 120)})` : ""}`;
}

export function renderRefreshMarkdown(r: RefreshReport): string {
  const parts: string[] = [];
  parts.push(
    r.sweep_within !== undefined
      ? `## Barrido de noticias ${r.date} (fiestas a ${r.sweep_within} días o menos)`
      : r.classify
        ? `## Clasificación ${r.date} (¿es una fiesta?, ¿viene gente de fuera?)`
        : `## Verificación ${r.date}`,
  );
  parts.push(
    `Cambios propuestos por la IA y validados en código (fuente citada, cita literal, ventana de la regla, dominios). ` +
      `Los aceptados se aplican solos; los marcados quedan retenidos. Modelo: \`${mdText(r.model, 40)}\`${r.dry_run ? " · ensayo (--dry-run)" : ""}.`,
  );
  if (r.stopped) parts.push(`> **La corrida se detuvo:** ${mdText(r.stopped, 300)}`);
  if (r.link_downgrades?.length) {
    const lines = r.link_downgrades.map(
      (d) => `- ${d.country} · ${mdText(d.slug, 60)} ${d.year} · confianza ${mdText(d.old)} → ${mdText(d.new)} · ${d.urls.map((u) => mdLink("fuente perdida", u)).join(", ")}`,
    );
    parts.push(
      `### Fuentes perdidas, confianza un nivel abajo (R13) (${r.link_downgrades.length})`,
      "Todas las fuentes de estas ediciones dan 404 o 410 y no tienen copia archivada. La próxima verificación busca una fuente nueva.",
      lines.join("\n"),
    );
  }
  if (r.drafts?.length) parts.push("### Países en borrador (R2)", r.drafts.map(draftLine).join("\n"));
  if (r.applied.length) {
    parts.push(`### Cambios aplicados (${r.applied.length})`, mdTable(HEADER, r.applied.map(row)), "### Citas", r.applied.map(quoteBlock).join("\n"));
  }
  if (r.flagged.length) {
    parts.push(`### Retenidos, no aplicados (${r.flagged.length})`, "Pasaron las fuentes pero tienen una marca. Quedan en data/state/holds.json; una verificación con una segunda fuente los aplica.", mdTable(HEADER, r.flagged.map(row)), r.flagged.map(quoteBlock).join("\n"));
  }
  if (r.confirmations.length) {
    const lines = r.confirmations.map((c) => `- ${c.country} · ${mdText(c.name, 60)} · ${mdText(fieldLabel(c.field))} ${mdText(c.new)} confirmado en ${sourceCell(c)}`);
    parts.push(`### Confirmaciones (${r.confirmations.length})`, "Solo actualizan la fecha de verificación y las fuentes.", lines.join("\n"));
  }
  if (r.rejected.length) {
    const lines = r.rejected.map((c) => `- ${c.country} · ${mdText(c.name, 60)} · ${mdText(fieldLabel(c.field))} → ${mdText(c.new)}: ${c.reasons.map((x) => mdText(x, 160)).join("; ")}`);
    parts.push(details(`Rechazados por la validación (${r.rejected.length})`, lines.join("\n")));
  }
  const log = r.festivals.map((f) => `- ${f.country}/${f.slug} ${f.year}: ${f.outcome}${f.detail ? ` (${mdText(f.detail, 160)})` : ""}${f.followup ? ` · ${followupText(f.followup)}` : ""}`);
  const spend = `Gasto del mes ${r.budget.month}: US$${r.budget.usd.toFixed(2)} de US$${r.budget.budget_usd.toFixed(2)} (${r.budget.searches} búsquedas, nivel ${r.budget.level}).`;
  parts.push(details("Registro de la corrida", `${spend}\n\n${log.join("\n")}`));
  return `${parts.join("\n\n")}\n`;
}

/** Tier-1 dates first, as in the table. */
export function tier1DateCount(changes: readonly ReviewedChange[]): number {
  return changes.filter(isTier1Date).length;
}

export function buildRefreshReport(base: Omit<RefreshReport, "kind" | "applied" | "confirmations" | "flagged" | "rejected">, s: Selection): RefreshReport {
  return { kind: "refresh", ...base, applied: s.applied, confirmations: s.confirmations, flagged: s.flagged, rejected: s.rejected };
}
