// R13: every accepted source gets an Internet Archive capture (Save Page Now 2, authenticated) and
// its archive_url is stored next to the source. Skipped silently in --dry-run or without keys.
import type { Logger } from "./io.ts";

export interface Archiver {
  /** Returns the capture URL, or null when the capture did not finish. Never throws. */
  capture(url: string): Promise<string | null>;
}

export const noopArchiver: Archiver = { capture: () => Promise.resolve(null) };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SpnOptions {
  accessKey: string;
  secretKey: string;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  maxPolls?: number;
  pollMs?: number;
}

const SAVE = "https://web.archive.org/save";

interface SaveResponse {
  job_id?: string;
  message?: string;
}
interface StatusResponse {
  status?: string;
  timestamp?: string;
  original_url?: string;
  message?: string;
}

/** `https://web.archive.org/web/<timestamp>/<url>`, only for a 14-digit timestamp. */
export function waybackUrl(timestamp: string, original: string): string | null {
  return /^\d{14}$/.test(timestamp) ? `https://web.archive.org/web/${timestamp}/${original}` : null;
}

export function spnArchiver(opts: SpnOptions): Archiver {
  const headers = {
    Accept: "application/json",
    Authorization: `LOW ${opts.accessKey}:${opts.secretKey}`,
  };
  const maxPolls = opts.maxPolls ?? 10;
  const pollMs = opts.pollMs ?? 6000;
  return {
    async capture(url) {
      try {
        // if_not_archived_within reuses a recent capture: SPN limits daily captures per URL.
        const body = new URLSearchParams({ url, if_not_archived_within: "1d" }).toString();
        const res = await opts.fetch(SAVE, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body });
        const saved = (await res.json()) as SaveResponse;
        if (!res.ok || !saved.job_id) {
          opts.log.warn(`R13: archive request for ${url} failed (${res.status}${saved.message ? `: ${saved.message}` : ""})`);
          return null;
        }
        for (let i = 0; i < maxPolls; i++) {
          await opts.sleep(pollMs);
          const st = await opts.fetch(`${SAVE}/status/${encodeURIComponent(saved.job_id)}`, { method: "GET", headers });
          const status = (await st.json()) as StatusResponse;
          if (status.status === "success" && status.timestamp) return waybackUrl(status.timestamp, status.original_url ?? url);
          if (status.status === "error") {
            opts.log.warn(`R13: archive of ${url} failed: ${status.message ?? "error"}`);
            return null;
          }
        }
        opts.log.warn(`R13: archive of ${url} still pending after ${maxPolls} checks`);
        return null;
      } catch (error) {
        opts.log.warn(`R13: archive of ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  };
}

export interface ArchiveEnv {
  ARCHIVE_ACCESS_KEY?: string;
  ARCHIVE_SECRET_KEY?: string;
}

/** Real archiver only for a real (non-dry, non-fixture) run with both keys present. */
export function archiverFor(env: ArchiveEnv, opts: { dryRun: boolean; offline: boolean; log: Logger }): Archiver {
  const access = env.ARCHIVE_ACCESS_KEY?.trim();
  const secret = env.ARCHIVE_SECRET_KEY?.trim();
  if (opts.dryRun || opts.offline || !access || !secret) return noopArchiver;
  return spnArchiver({
    accessKey: access,
    secretKey: secret,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: opts.log,
  });
}

/** Captures each distinct URL once. */
export async function archiveAll(archiver: Archiver, urls: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const url of [...new Set(urls)]) {
    const archived = await archiver.capture(url);
    if (archived) out.set(url, archived);
  }
  return out;
}
