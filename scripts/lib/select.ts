// R12: a PR carries at most 15 changes for a human to review, riskiest first (tier-1 dates on top).
import type { ReviewedChange } from "./validate.ts";

export const PR_MAX_CHANGES = 15;

export interface Selection {
  /** Accepted value changes that go into the data files (the trap, when present, is one of them). */
  applied: ReviewedChange[];
  /** Accepted confirmations: refresh last_verified and sources only; not counted in the cap. */
  confirmations: ReviewedChange[];
  /** Shown to the reviewer, never applied. */
  flagged: ReviewedChange[];
  rejected: ReviewedChange[];
  /** Over the cap: verified again next run. */
  deferred: ReviewedChange[];
}

export function byRisk(a: ReviewedChange, b: ReviewedChange): number {
  return b.risk - a.risk || a.daysToStart - b.daysToStart || `${a.country}/${a.slug}/${a.field}`.localeCompare(`${b.country}/${b.slug}/${b.field}`);
}

const fieldKey = (c: ReviewedChange): string => `${c.country}/${c.slug}/${c.year}/${c.field}`;

export function selectForPr(all: readonly ReviewedChange[], trap: ReviewedChange | null, max = PR_MAX_CHANGES): Selection {
  const reviewable = all.filter((c) => c.verdict === "flagged" || (c.verdict === "accepted" && c.kind === "change")).sort(byRisk);
  const room = Math.max(0, max - (trap ? 1 : 0));
  const kept = reviewable.slice(0, room);
  const applied = [...kept.filter((c) => c.verdict === "accepted"), ...(trap ? [trap] : [])].sort(byRisk);
  // A confirmation of a field that is also changed (the trap, typically) would undo the change on apply.
  const changed = new Set(applied.map(fieldKey));
  return {
    applied,
    confirmations: all.filter((c) => c.verdict === "accepted" && c.kind === "confirmation" && !changed.has(fieldKey(c))).sort(byRisk),
    flagged: kept.filter((c) => c.verdict === "flagged"),
    rejected: all.filter((c) => c.verdict === "rejected").sort(byRisk),
    deferred: reviewable.slice(room),
  };
}

/** Number of data changes a PR would carry (what `changes=<n>` reports). */
export function dataChangeCount(s: Selection): number {
  return s.applied.length + s.confirmations.length;
}
