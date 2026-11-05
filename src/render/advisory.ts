// Travel advisories (R6). Reads config/advisories.json `origins` only:
// origins[O].destinations[D], then origins[O].fallback. The `unverified` list is never read.
// Pure, so it runs in Node too; model.ts binds it to the bundled config.

/** Origins whose official pages are consular information, not risk-level advisories. */
export const CONSULAR_ORIGINS: ReadonlySet<string> = new Set(["AR", "CL", "BR"]);

export type AdvisoryKind = "advisory" | "consular";

export interface Advisory {
  url: string;
  publisher: string | null;
  kind: AdvisoryKind;
  /** true when the page is for this destination, false for the origin's general page. */
  specific: boolean;
}

export interface OriginAdvisories {
  publisher: string | null;
  destinations: Readonly<Record<string, string>>;
  fallback: string | null;
}

export type OriginTable = Readonly<Record<string, OriginAdvisories>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/** Narrows the `origins` object of config/advisories.json; malformed entries are dropped. */
export function parseOrigins(raw: unknown): OriginTable {
  if (!isRecord(raw)) return {};
  const table: Record<string, OriginAdvisories> = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!/^[A-Z]{2}$/.test(code) || !isRecord(value)) continue;
    const destinations: Record<string, string> = {};
    if (isRecord(value.destinations)) {
      for (const [dest, url] of Object.entries(value.destinations)) {
        const safe = httpsUrl(url);
        if (/^[A-Z]{2}$/.test(dest) && safe) destinations[dest] = safe;
      }
    }
    table[code] = {
      publisher: typeof value.publisher === "string" && value.publisher.trim() ? value.publisher : null,
      destinations,
      fallback: httpsUrl(value.fallback),
    };
  }
  return table;
}

/** The origin's page for this destination, else its general page; never for a trip inside the origin. */
export function pickAdvisory(table: OriginTable, origin: string | null, destination: string): Advisory | null {
  if (!origin) return null;
  const o = origin.toUpperCase();
  const d = destination.toUpperCase();
  if (o === d) return null;
  const entry = table[o];
  if (!entry) return null;
  const specific = entry.destinations[d] ?? null;
  const url = specific ?? entry.fallback;
  if (!url) return null;
  return { url, publisher: entry.publisher, kind: CONSULAR_ORIGINS.has(o) ? "consular" : "advisory", specific: specific !== null };
}
