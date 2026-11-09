// Edition status (RF-07, RF-18, R9): one lifecycle, read the same way by the screens, the calendar
// feeds and the pipeline. Pure, shared by app and scripts.
//
//   (rule only) ─▶ por_anunciar ⇄ tentativa ──▶ confirmada
//                       │              │             │
//                       └──────────────┴─────────────┴──▶ aplazada ──▶ tentativa | confirmada (new dates)
//                                                    └──▶ cancelada ──▶ (back only after a person checks)
//
// Only the pipeline moves an edition: scripts/lib/validate.ts `statusMoveCheck` holds the evidence
// each move needs, and apply.ts stores it and bumps SEQUENCE. What each status needs to be stored
// (dates, a source) is in schema.ts `Edition`. Everything else asks STATUS_TRAITS what a status
// means instead of comparing status strings, so a new status is a compile error until every trait
// is decided.
import type { Status } from "./schema.ts";

export interface StatusTraits {
  /** The edition still happens: it can lead «Lo próximo», it counts down, the news sweep (R9) watches it. */
  takesPlace: boolean;
  /** A source settled it: the weekly run re-verifies it only when stale (R10), and no follow-up hunts for its dates. */
  settled: boolean;
  /**
   * Stored without dates, it keeps the days its rule gave in the calendar feeds, marked with this
   * status: subscribers hold that event, so they must get the news, not lose the event (R9, RF-18).
   */
  keepsRuleDays: boolean;
}

export const STATUS_TRAITS: Readonly<Record<Status, StatusTraits>> = {
  por_anunciar: { takesPlace: true, settled: false, keepsRuleDays: false },
  tentativa: { takesPlace: true, settled: false, keepsRuleDays: false },
  confirmada: { takesPlace: true, settled: true, keepsRuleDays: false },
  aplazada: { takesPlace: true, settled: false, keepsRuleDays: true },
  cancelada: { takesPlace: false, settled: true, keepsRuleDays: true },
};
