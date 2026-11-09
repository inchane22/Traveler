// Countries built on request (data/state/requests.json). The lifecycle has one home, `nextRequest`
// (docs/architecture.md «State machines»):
//
//   (none) ── request ──▶ queued ── built, passes R2 ──▶ live
//                           │  ▲
//                           │  └── due (retry_after reached; the planner treats it as queued)
//                           └── built, short of R2 ──▶ retry ── built, short, last attempt ──▶ gave_up
//   retry | gave_up ── request ──▶ queued (attempts start over: a person asked again)
//   any ── published (an existing draft passed on its own) ──▶ live
//
// An error mid-build (budget, API) is not an attempt: the request stays as it was, with a note.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { addDays, type ISO } from "../../src/dates.ts";
import { CountryCode, ISODate } from "../../src/schema.ts";
import { writeJson } from "./io.ts";

export const RequestStatus = z.enum(["queued", "retry", "live", "gave_up"]);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const CountryRequest = z
  .object({
    country: CountryCode,
    requested_at: ISODate,
    status: RequestStatus,
    /** Builds that ran to the end without reaching the R2 gate. */
    attempts: z.number().int().min(0),
    /** GitHub issue that asked for it, when one did. */
    issue: z.number().int().positive().optional(),
    last_attempt: ISODate.optional(),
    retry_after: ISODate.optional(),
    live_since: ISODate.optional(),
    note: z.string().max(300).optional(),
  })
  .strict();
export type CountryRequest = z.infer<typeof CountryRequest>;
export const RequestsFile = z.array(CountryRequest);

export const REQUESTS_PATH = join("data", "state", "requests.json");

export interface RequestRules {
  maxAttempts: number;
  retryDays: number;
}

export type RequestEvent =
  | { type: "request"; today: ISO; issue?: number }
  | { type: "built"; today: ISO; published: boolean; note?: string }
  | { type: "error"; today: ISO; note: string }
  | { type: "published"; today: ISO };

const clip = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

/** The request after `event`; `undefined` in means the country was never asked for. */
export function nextRequest(req: CountryRequest | undefined, country: string, event: RequestEvent, rules: RequestRules): CountryRequest {
  const base: CountryRequest = req ?? { country, requested_at: event.today, status: "queued", attempts: 0 };
  switch (event.type) {
    case "request": {
      const issue = event.issue ?? base.issue;
      const withIssue = issue ? { ...base, issue } : base;
      if (!req || base.status === "queued" || base.status === "live") return withIssue;
      const { retry_after: _r, note: _n, ...rest } = withIssue;
      return { ...rest, status: "queued", attempts: 0, requested_at: event.today };
    }
    case "built": {
      const attempts = base.attempts + 1;
      const { retry_after: _r, note: _n, ...rest } = base;
      const note = event.note ? { note: clip(event.note) } : {};
      if (event.published) return { ...rest, status: "live", attempts, last_attempt: event.today, live_since: event.today };
      if (attempts >= rules.maxAttempts) return { ...rest, status: "gave_up", attempts, last_attempt: event.today, ...note };
      return { ...rest, status: "retry", attempts, last_attempt: event.today, retry_after: addDays(event.today, rules.retryDays), ...note };
    }
    case "error":
      return { ...base, note: clip(event.note) };
    case "published": {
      if (base.status === "live") return base;
      const { retry_after: _r, note: _n, ...rest } = base;
      return { ...rest, status: "live", live_since: event.today };
    }
  }
}

/** What the planner may build today: queued first in request order, then retries that are due. */
export function requestsDue(requests: readonly CountryRequest[], today: ISO): CountryRequest[] {
  const byAge = (a: CountryRequest, b: CountryRequest) => a.requested_at.localeCompare(b.requested_at) || a.country.localeCompare(b.country);
  const queued = requests.filter((r) => r.status === "queued").sort(byAge);
  const due = requests.filter((r) => r.status === "retry" && (!r.retry_after || r.retry_after <= today)).sort(byAge);
  return [...queued, ...due];
}

export function upsertRequest(requests: readonly CountryRequest[], next: CountryRequest): CountryRequest[] {
  const out = requests.filter((r) => r.country !== next.country);
  out.push(next);
  return out.sort((a, b) => a.country.localeCompare(b.country));
}

export function readRequests(root: string): CountryRequest[] {
  const path = join(root, REQUESTS_PATH);
  return existsSync(path) ? RequestsFile.parse(JSON.parse(readFileSync(path, "utf8"))) : [];
}

export function writeRequests(root: string, requests: readonly CountryRequest[]): void {
  writeJson(join(root, REQUESTS_PATH), RequestsFile.parse(requests));
}

/**
 * Two letters from an issue: the «build-country» form renders its field as a `### …` heading and
 * the value; a title like «Build: JP» works too. Anything else is not a request.
 */
export function countryFromIssue(title: string, body: string): string | null {
  const field = /###[^\n]*\n+\s*([A-Za-z]{2})\s*(?:\n|$)/.exec(body);
  const fromTitle = /^\s*(?:build|construir|construir país|crear)\s*:?\s*([A-Za-z]{2})\s*$/i.exec(title);
  const code = (field?.[1] ?? fromTitle?.[1])?.toUpperCase();
  return code ?? null;
}
