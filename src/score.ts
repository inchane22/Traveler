// Festival score (PRD «Criterios de priorización»). Weights live in config/scoring.json.
import type { ScoreInputs } from "./schema.ts";

export type CriterionKey = keyof ScoreInputs;
export const CRITERIA: readonly CriterionKey[] = ["convocatoria", "calle", "reconocimiento", "conectividad", "local"];

export interface ScoringConfig {
  criteria: {
    convocatoria: { max: number; scale: Array<{ min: number; points: number }> };
    calle: { max: number; levels: Record<string, number> };
    reconocimiento: { max: number; levels: Record<string, number> };
    conectividad: { max: number; levels: Record<string, number> };
    local: { max: number; levels: Record<string, number> };
  };
  thresholds: { tier1: number; tier2: number };
  country_top_n: number;
}

export type Tier = 1 | 2 | "provisional" | "hidden";

export interface CriterionScore {
  key: CriterionKey;
  /** null = «por medir» */
  points: number | null;
  max: number;
}

export interface ScoreResult {
  low: number;
  high: number;
  measured: boolean;
  tier: Tier;
  criteria: CriterionScore[];
}

function pointsFor(key: CriterionKey, inputs: ScoreInputs, config: ScoringConfig): number | null {
  if (key === "convocatoria") {
    const measure = inputs.convocatoria?.measure;
    if (!measure) return null;
    const step = config.criteria.convocatoria.scale.find((s) => measure.attendance >= s.min);
    return step?.points ?? 0;
  }
  const level = inputs[key]?.measure;
  if (level === undefined) return null;
  return config.criteria[key].levels[level] ?? 0;
}

/** Tier 1 needs the low end ≥ tier1; a range that straddles a threshold stays provisional. */
export function classify(low: number, high: number, t: ScoringConfig["thresholds"]): Tier {
  if (low >= t.tier1) return 1;
  if (high < t.tier2) return "hidden";
  if (low >= t.tier2 && high < t.tier1) return 2;
  return "provisional";
}

export function scoreFestival(inputs: ScoreInputs, config: ScoringConfig): ScoreResult {
  const criteria = CRITERIA.map((key) => ({ key, points: pointsFor(key, inputs, config), max: config.criteria[key].max }));
  const low = criteria.reduce((sum, c) => sum + (c.points ?? 0), 0);
  const high = criteria.reduce((sum, c) => sum + (c.points ?? c.max), 0);
  return { low, high, measured: criteria.every((c) => c.points !== null), tier: classify(low, high, config.thresholds), criteria };
}
