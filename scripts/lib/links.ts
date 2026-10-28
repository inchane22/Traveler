// R6 and R13: weekly check of every https link the site shows or relies on (travel advisories,
// data sources and their archive copies), and the confidence rule for sources that are gone.
// The network sits behind LinkFetch so tests run on a fake; everything else here is pure.
import { z } from "zod";
import { diffDays } from "../../src/dates.ts";
import { ChangelogEntry, ISODate, type Confidence, type CountryFile, type Edition, type Source } from "../../src/schema.ts";
import { mdLink, mdTable, mdText } from "./markdown.ts";

export type LinkVerdict = "ok" | "broken" | "unknown";

export interface LinkResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** When present, the body is read only up to BODY_SNIFF bytes (SEC-08). */
  body?: ReadableStream<Uint8Array> | null;
}

export interface LinkRequest {
  method: "HEAD" | "GET";
  headers: Record<string, string>;
  /** Redirects are followed by checkLink, hop by hop, so every hop passes the address guard. */
  redirect: "manual";
  signal: AbortSignal;
}

/** Addresses a host name resolves to (DNS in check-links.ts, a fake in tests). */
export type ResolveHost = (host: string) => Promise<string[]>;

export type LinkFetch = (url: string, init: LinkRequest) => Promise<LinkResponse>;

export interface LinkRef {
  url: string;
  /** Where the link lives, for the report («config/advisories.json origins.GB.destinations.CO»). */
  where: string;
}

export interface LinkResult {
  url: string;
  verdict: LinkVerdict;
  status: number | null;
  method: "HEAD" | "GET";
  detail: string;
  where: string[];
}

export const LinksReport = z.object({
  kind: z.literal("links"),
  date: ISODate,
  checked: z.number().int().min(0),
  ok: z.number().int().min(0),
  broken: z.number().int().min(0),
  unknown: z.number().int().min(0),
  results: z.array(
    z.object({
      url: z.string(),
      verdict: z.enum(["ok", "broken", "unknown"]),
      status: z.number().int().nullable(),
      method: z.enum(["HEAD", "GET"]),
      detail: z.string(),
      where: z.array(z.string()),
    }),
  ),
});
export type LinksReport = z.infer<typeof LinksReport>;

export const USER_AGENT = "TravelerLinkCheck/1.0 (weekly broken-link check, R6/R13)";
export const TIMEOUT_MS = 20_000;
export const CONCURRENCY = 4;
/** Only the start of a page is read: enough to spot a challenge page. */
const BODY_SNIFF = 16_384;

const HTTPS_URL = /^https:\/\/\S+$/;

/** Every string value that is a whole https URL, with its JSON path. Prose that mentions a URL is skipped. */
export function urlsInJson(value: unknown, label: string, path: readonly string[] = []): LinkRef[] {
  if (typeof value === "string") return HTTPS_URL.test(value) ? [{ url: value, where: `${label} ${path.join(".")}`.trim() }] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => urlsInJson(v, label, [...path, String(i)]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => urlsInJson(v, label, [...path, k]));
  return [];
}

/** Source, archive, score and rule-table URLs of every festival. */
export function dataLinks(countries: readonly CountryFile[]): LinkRef[] {
  return countries.flatMap((c) =>
    c.festivals.flatMap((f) => {
      const at = `${c.country}/${f.slug}`;
      const refs: LinkRef[] = [];
      if (f.rule.type === "lunisolar_table") refs.push({ url: f.rule.table_source, where: `${at} rule table` });
      for (const [year, e] of Object.entries(f.editions)) {
        e.sources.forEach((s, i) => {
          refs.push({ url: s.url, where: `${at} ${year} sources[${i}]` });
          if (s.archive_url) refs.push({ url: s.archive_url, where: `${at} ${year} sources[${i}] archive` });
        });
      }
      for (const [criterion, m] of Object.entries(f.score)) {
        if (m?.source) refs.push({ url: m.source, where: `${at} score.${criterion}` });
      }
      return refs;
    }),
  );
}

/** 2xx/3xx ok, 404/410 broken; anything else (401, 403, 418, 429, 5xx...) cannot tell. */
export function verdictForStatus(status: number): LinkVerdict {
  if (status >= 200 && status < 400) return "ok";
  if (status === 404 || status === 410) return "broken";
  return "unknown";
}

/**
 * Markers that only challenge pages carry (Cloudflare, Imperva, PerimeterX). Generic words such as
 * «captcha» or Cloudflare's «challenge-platform» script also appear on normal pages, so they are out.
 */
const CHALLENGE_MARKERS = ["<title>just a moment...</title>", "_cf_chl_opt", "cf-chl-", "attention required! | cloudflare", "cf-browser-verification", "_incapsula_resource", "px-captcha"];

/** Bot walls answer with a challenge page, not the page itself: that says nothing about the link. */
export function isBotChallenge(headers: LinkResponse["headers"], body: string): boolean {
  if ((headers.get("cf-mitigated") ?? "").toLowerCase() === "challenge") return true;
  const text = body.toLowerCase();
  return CHALLENGE_MARKERS.some((m) => text.includes(m));
}

/**
 * Generic reason only: the report lands in the job summary, and causes such as ECONNREFUSED or
 * ENOTFOUND would tell anyone which hosts the runner can reach (SEC-08).
 */
function errorText(error: unknown): string {
  if (error instanceof BlockedAddressError || error instanceof RedirectError) return error.message;
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error";
}

export const MAX_REDIRECTS = 5;

class BlockedAddressError extends Error {
  constructor() {
    super("blocked: not a public https address");
  }
}

class RedirectError extends Error {
  constructor(why: string) {
    super(why);
  }
}

const v4 = (ip: string): number[] | null => {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
};

/**
 * IPv4 inside an IPv6 literal: mapped (::ffff:0:0/96 and ::ffff:0:0:0/96), compatible (::/96) and
 * NAT64 (64:ff9b::/96), dotted or in the hex form the URL parser rewrites them to (BE-03).
 */
const EMBEDDED_V4 = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/;

function embeddedV4(addr: string): string | null {
  const m = EMBEDDED_V4.exec(addr);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2]!, 16);
  const lo = parseInt(m[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Loopback, private, link-local, CGNAT, unspecified and multicast addresses (IPv4 and IPv6), also
 * when an IPv6 literal wraps one; 6to4 (2002::/16) and site-local (fec0::/10) are refused outright.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const p = v4(embeddedV4(addr) ?? addr);
  if (p) {
    const [a, b] = p as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!addr.includes(":")) return false;
  return addr === "::" || addr === "::1" || /^f[cd]/.test(addr) || /^fe[89a-f]/.test(addr) || /^ff/.test(addr) || /^2002:/.test(addr);
}

/** https, a public host name or address, and (with a resolver) only public addresses behind it. */
export async function isPublicHttps(url: string, resolveHost?: ResolveHost): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:" || host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  if (v4(host) || host.includes(":")) return !isPrivateAddress(host);
  if (!resolveHost) return true;
  const addresses = await resolveHost(host);
  return addresses.length > 0 && !addresses.some(isPrivateAddress);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Follows redirects by hand, checking every hop, at most MAX_REDIRECTS times. */
async function fetchGuarded(url: string, init: LinkRequest, fetcher: LinkFetch, resolveHost?: ResolveHost): Promise<LinkResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublicHttps(current, resolveHost))) throw new BlockedAddressError();
    const res = await fetcher(current, init);
    const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
    if (!location) return res;
    try {
      current = new URL(location, current).href;
    } catch {
      throw new RedirectError("redirect to an invalid address");
    }
  }
  throw new RedirectError(`more than ${MAX_REDIRECTS} redirects`);
}

/** At most `limit` bytes of the body; the rest is never downloaded. */
async function readSniff(res: LinkResponse, limit = BODY_SNIFF): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, limit);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all.slice(0, limit));
}

/**
 * HEAD first; anything but a clean 2xx/3xx is confirmed with GET, because many servers answer
 * HEAD with 403, 404 or 405 while the page works. Network errors are «unknown», never «broken».
 */
export async function checkLink(url: string, fetcher: LinkFetch, timeoutMs = TIMEOUT_MS, resolveHost?: ResolveHost): Promise<Omit<LinkResult, "where">> {
  const init = (method: "HEAD" | "GET"): LinkRequest => ({
    method,
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let allowed: boolean;
  try {
    allowed = await isPublicHttps(url, resolveHost);
  } catch (error) {
    // The host did not resolve: a network failure, reported generically like any other.
    return { url, verdict: "unknown", status: null, method: "HEAD", detail: `HEAD failed: ${errorText(error)}` };
  }
  if (!allowed) return { url, verdict: "unknown", status: null, method: "HEAD", detail: new BlockedAddressError().message };
  let headNote = "";
  try {
    const head = await fetchGuarded(url, init("HEAD"), fetcher, resolveHost);
    if (verdictForStatus(head.status) === "ok" && !isBotChallenge(head.headers, "")) return { url, verdict: "ok", status: head.status, method: "HEAD", detail: "" };
    headNote = `HEAD ${head.status}`;
  } catch (error) {
    headNote = `HEAD failed: ${errorText(error)}`;
  }
  try {
    const res = await fetchGuarded(url, init("GET"), fetcher, resolveHost);
    const body = await readSniff(res);
    if (isBotChallenge(res.headers, body)) return { url, verdict: "unknown", status: res.status, method: "GET", detail: `bot challenge (${headNote})` };
    return { url, verdict: verdictForStatus(res.status), status: res.status, method: "GET", detail: headNote };
  } catch (error) {
    return { url, verdict: "unknown", status: null, method: "GET", detail: `GET failed: ${errorText(error)} (${headNote})` };
  }
}

/** Each distinct URL once, `concurrency` at a time, in a stable order (broken first, then unknown, then ok). */
export async function checkLinks(refs: readonly LinkRef[], fetcher: LinkFetch, opts: { concurrency?: number; timeoutMs?: number; resolveHost?: ResolveHost } = {}): Promise<LinkResult[]> {
  const where = new Map<string, string[]>();
  for (const r of refs) where.set(r.url, [...(where.get(r.url) ?? []), r.where]);
  const urls = [...where.keys()];
  const results: LinkResult[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const url = urls[next++]!;
      const r = await checkLink(url, fetcher, opts.timeoutMs, opts.resolveHost);
      results.push({ ...r, where: where.get(url)! });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, urls.length)) }, worker));
  const rank: Record<LinkVerdict, number> = { broken: 0, unknown: 1, ok: 2 };
  return results.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.url.localeCompare(b.url));
}

export function buildLinksReport(date: string, results: readonly LinkResult[]): LinksReport {
  const count = (v: LinkVerdict) => results.filter((r) => r.verdict === v).length;
  return { kind: "links", date, checked: results.length, ok: count("ok"), broken: count("broken"), unknown: count("unknown"), results: [...results] };
}

const LINK_HEADER = ["Enlace", "Estado", "Dónde", "Detalle"];

function linkRow(r: LinksReport["results"][number]): string[] {
  return [mdLink(r.url, r.url), r.status === null ? "sin respuesta" : String(r.status), r.where.map((w) => mdText(w, 80)).join("<br>"), r.detail ? mdText(r.detail, 160) : ""];
}

/** proposals/links-<date>.md: what to fix first, then what nobody could verify. */
export function renderLinksMarkdown(r: LinksReport): string {
  const broken = r.results.filter((x) => x.verdict === "broken");
  const unknown = r.results.filter((x) => x.verdict === "unknown");
  const parts = [
    `## Chequeo de enlaces ${r.date}`,
    `${r.checked} enlaces revisados: ${r.broken} rotos, ${r.unknown} sin verificar, ${r.ok} bien. ` +
      "Roto es solo 404 o 410. 401, 403, 418, 429, 5xx, errores de red y páginas anti-bots quedan sin verificar: ábrelos a mano antes de cambiar nada.",
  ];
  if (broken.length) parts.push(`### Rotos (${broken.length})`, "Una advertencia de viaje rota se reemplaza por la vigente del mismo gobierno (R6). Una fuente rota sin copia archivada baja la confianza de su edición un nivel en el siguiente refresh (R13).", mdTable(LINK_HEADER, broken.map(linkRow)));
  if (unknown.length) parts.push(`### Sin verificar (${unknown.length})`, mdTable(LINK_HEADER, unknown.map(linkRow)));
  return `${parts.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// R13: «sin original ni copia archivada, la confianza baja un nivel».

const LOWER: Record<Confidence, Confidence> = { oficial: "prensa", prensa: "patron", patron: "estimacion", estimacion: "estimacion" };

export function lowerConfidence(c: Confidence): Confidence {
  return LOWER[c];
}

/** The original is broken (404/410) and there is no archive copy, or the copy is broken too. «unknown» never counts. */
export function isLost(source: Source, verdicts: ReadonlyMap<string, LinkVerdict>): boolean {
  if (verdicts.get(source.url) !== "broken") return false;
  return !source.archive_url || verdicts.get(source.archive_url) === "broken";
}

export interface LinkDowngrade {
  country: string;
  slug: string;
  year: number;
  old: Confidence;
  new: Confidence;
  urls: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * One level down for an edition whose sources are all lost. Idempotent across weekly runs: a
 * changelog «confidence» entry for the same festival that lists the same lost URLs means the
 * downgrade was already made. [assumption: the changelog has no edition year, so two editions
 * citing exactly the same dead URLs share that guard]
 */
export function editionDowngrade(edition: Edition, verdicts: ReadonlyMap<string, LinkVerdict>, prior: readonly ChangelogEntry[]): { confidence: Confidence; urls: string[] } | null {
  if (!edition.sources.length || !edition.sources.every((s) => isLost(s, verdicts))) return null;
  const urls = [...new Set(edition.sources.map((s) => s.url))];
  if (prior.some((e) => e.field === "confidence" && sameSet(e.source_urls, urls))) return null;
  const confidence = lowerConfidence(edition.confidence);
  return confidence === edition.confidence ? null : { confidence, urls };
}

export interface LinkCheckResult {
  country: CountryFile;
  downgrades: LinkDowngrade[];
  entries: ChangelogEntry[];
}

/** Country file with the R13 downgrades applied (same object when nothing changes). No last_verified or SEQUENCE change: no new fact was verified. */
export function applyLostSources(country: CountryFile, verdicts: ReadonlyMap<string, LinkVerdict>, changelog: readonly ChangelogEntry[], today: string): LinkCheckResult {
  const downgrades: LinkDowngrade[] = [];
  const festivals = country.festivals.map((f) => {
    const prior = changelog.filter((e) => e.country === country.country && e.slug === f.slug);
    let editions = f.editions;
    for (const [year, edition] of Object.entries(f.editions)) {
      const d = editionDowngrade(edition, verdicts, prior);
      if (!d) continue;
      editions = { ...editions, [year]: { ...edition, confidence: d.confidence } };
      downgrades.push({ country: country.country, slug: f.slug, year: Number(year), old: edition.confidence, new: d.confidence, urls: d.urls });
    }
    return editions === f.editions ? f : { ...f, editions };
  });
  if (!downgrades.length) return { country, downgrades, entries: [] };
  const entries = downgrades.map((d) => ChangelogEntry.parse({ date: today, country: d.country, slug: d.slug, field: "confidence", old: d.old, new: d.new, source_urls: d.urls }));
  return { country: { ...country, festivals }, downgrades, entries };
}

/** Verdict per URL from a check-links report. */
export function verdictMap(report: LinksReport): Map<string, LinkVerdict> {
  return new Map(report.results.map((r) => [r.url, r.verdict]));
}

/** A links report older than this is not used for R13: a page can come back within weeks. */
export const LINKS_MAX_AGE_DAYS = 7;

/**
 * Verdicts from LINKS_REPORT_PATH for R13, or null (no R13 this run) when the variable is unset,
 * the file is missing, invalid, from the future or older than LINKS_MAX_AGE_DAYS. Logged either way.
 */
export function readLinksReport(path: string | undefined, today: string, io: { read: (p: string) => unknown; exists: (p: string) => boolean }, log: { info(m: string): void; warn(m: string): void }): Map<string, LinkVerdict> | null {
  const file = path?.trim();
  if (!file) return null;
  if (!io.exists(file)) {
    log.warn(`R13: LINKS_REPORT_PATH ${file} does not exist; source downgrades skipped`);
    return null;
  }
  let raw: unknown;
  try {
    raw = io.read(file);
  } catch (error) {
    log.warn(`R13: ${file} is not valid JSON (${errorText(error)}); source downgrades skipped`);
    return null;
  }
  const parsed = LinksReport.safeParse(raw);
  if (!parsed.success) {
    log.warn(`R13: ${file} is not a check-links report; source downgrades skipped`);
    return null;
  }
  const age = diffDays(parsed.data.date, today);
  if (age < 0 || age > LINKS_MAX_AGE_DAYS) {
    log.warn(`R13: links report of ${parsed.data.date} is ${age < 0 ? "from after" : "too old for"} ${today}; source downgrades skipped`);
    return null;
  }
  log.info(`R13: using links report of ${parsed.data.date} (${parsed.data.broken} broken)`);
  return verdictMap(parsed.data);
}
