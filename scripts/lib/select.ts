// Auto-approval: every accepted change is applied, flagged ones are held (data/state/holds.json),
// rejected ones are only reported. No cap: nobody has to read the batch, the checks did.
import type { ReviewedChange } from "./validate.ts";

export interface Selection {
  /** Accepted value changes that go into the data files. */
  applied: ReviewedChange[];
  /** Accepted confirmations: refresh last_verified and sources only. */
  confirmations: ReviewedChange[];
  /** Held: never applied; listed on the «Needs a look» issue. */
  flagged: ReviewedChange[];
  rejected: ReviewedChange[];
}

/** Riskiest first (tier-1 dates on top), so the report and the commit message lead with them. */
export function byRisk(a: ReviewedChange, b: ReviewedChange): number {
  return b.risk - a.risk || a.daysToStart - b.daysToStart || `${a.country}/${a.slug}/${a.field}`.localeCompare(`${b.country}/${b.slug}/${b.field}`);
}

const fieldKey = (c: ReviewedChange): string => `${c.country}/${c.slug}/${c.year}/${c.field}`;

export function selectForApply(all: readonly ReviewedChange[]): Selection {
  const applied = all.filter((c) => c.verdict === "accepted" && c.kind === "change").sort(byRisk);
  // A confirmation of a field that is also changed would undo the change on apply.
  const changed = new Set(applied.map(fieldKey));
  return {
    applied,
    confirmations: all.filter((c) => c.verdict === "accepted" && c.kind === "confirmation" && !changed.has(fieldKey(c))).sort(byRisk),
    flagged: all.filter((c) => c.verdict === "flagged").sort(byRisk),
    rejected: all.filter((c) => c.verdict === "rejected").sort(byRisk),
  };
}

/** Number of data changes the run writes (what `changes=<n>` reports). */
export function dataChangeCount(s: Selection): number {
  return s.applied.length + s.confirmations.length;
}
