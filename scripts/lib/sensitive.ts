// R5: sensitive terms per festival type force a human review of the text that carries them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FestivalType, type Festival } from "../../src/schema.ts";
import { foldText } from "./lang.ts";

export const SensitiveTerms = z.record(z.string(), z.union([z.array(z.string().min(2)), z.string()]));
export type TermsByType = Partial<Record<z.infer<typeof FestivalType>, readonly string[]>>;

/** config/sensitive-terms.json; keys that are not festival types (`_note`) are ignored. */
export function loadSensitiveTerms(root: string): TermsByType {
  const path = join(root, "config", "sensitive-terms.json");
  if (!existsSync(path)) throw new Error(`R5: ${path} is missing`);
  const raw = SensitiveTerms.parse(JSON.parse(readFileSync(path, "utf8")));
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => FestivalType.safeParse(k).success && Array.isArray(v))) as TermsByType;
}

export interface SensitiveHit {
  slug: string;
  field: string;
  term: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word (plurals included), case- and accent-insensitive hits in the names, street_tip and etiquette texts. */
export function sensitiveHits(festival: Festival, terms: TermsByType): SensitiveHit[] {
  const list = terms[festival.type] ?? [];
  if (!list.length) return [];
  const texts: Array<[string, string | undefined]> = [
    ...Object.entries(festival.names).map(([k, v]) => [`names.${k}`, v] as [string, string]),
    ...(["street_tip", "etiquette"] as const).flatMap((k) => Object.entries(festival[k] ?? {}).map(([lang, v]) => [`${k}.${lang}`, v] as [string, string | undefined])),
  ];
  const hits: SensitiveHit[] = [];
  for (const [field, text] of texts) {
    if (!text) continue;
    const folded = foldText(text);
    for (const term of list) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escape(foldText(term))}(?:e?s)?($|[^\\p{L}\\p{N}])`, "u").test(folded)) hits.push({ slug: festival.slug, field, term });
    }
  }
  return hits;
}
