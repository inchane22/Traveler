// What stands in for the person who used to approve every change. On top of validate.ts, a change
// that is hard to undo for a traveller needs more evidence, and a run that rewrites a country
// wholesale is held as a whole. Held means flagged: never applied, listed for a look. Pure.
import type { CountryFile } from "../../src/schema.ts";
import type { ReviewedChange } from "./validate.ts";

/** Sites a change rests on; two pages of one outlet are one voice. */
export function independentSources(c: ReviewedChange): number {
  return new Set(c.sources.map((s) => s.domain)).size;
}

/** Stricter cases: moving a date or status a source had settled, or calling an edition off. */
export function needsTwoSources(c: ReviewedChange, country: CountryFile | undefined): boolean {
  if (c.kind !== "change") return false;
  if (c.field === "status" && (c.new === "cancelada" || c.new === "aplazada")) return true;
  if (c.field !== "start" && c.field !== "end" && c.field !== "status") return false;
  const stored = country?.festivals.find((f) => f.slug === c.slug)?.editions[String(c.year)];
  return stored?.status === "confirmada";
}

/** A run that changes more than this share of a country's dated editions is held whole. */
export const MASS_CHANGE_SHARE = 0.5;
/** … and at least this many of them, so a country with two dated editions can still move one. */
export const MASS_CHANGE_MIN = 3;

function datedEditions(country: CountryFile): number {
  return country.festivals.filter((f) => Object.values(f.editions).some((e) => e.start && e.end)).length;
}

const hold = (c: ReviewedChange, why: string): ReviewedChange => ({ ...c, verdict: "flagged", flags: [...c.flags, why] });

/**
 * Accepted changes that need more than validate.ts asks for become flagged. Flagged and rejected
 * changes come back as they were; a later run that finds a second source applies the change then.
 */
export function holdRisky(changes: readonly ReviewedChange[], countries: readonly CountryFile[]): ReviewedChange[] {
  const byCode = new Map(countries.map((c) => [c.country, c]));
  const first = changes.map((c) =>
    c.verdict === "accepted" && needsTwoSources(c, byCode.get(c.country)) && independentSources(c) < 2
      ? hold(c, "retenido: un cambio que mueve una fecha confirmada o suspende la fiesta necesita dos fuentes de sitios distintos")
      : c,
  );
  const massive = new Set<string>();
  for (const country of countries) {
    const moved = new Set(
      first.filter((c) => c.country === country.country && c.verdict === "accepted" && c.kind === "change" && (c.field === "start" || c.field === "end") && c.old !== null).map((c) => c.slug),
    );
    const dated = datedEditions(country);
    if (moved.size >= MASS_CHANGE_MIN && moved.size > dated * MASS_CHANGE_SHARE) massive.add(country.country);
  }
  return first.map((c) =>
    massive.has(c.country) && c.verdict === "accepted"
      ? hold(c, `retenido: la corrida cambia más de la mitad de las fechas de ${c.country}; se revisa entera`)
      : c,
  );
}
