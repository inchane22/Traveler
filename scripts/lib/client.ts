// Every Claude API call goes through MessagesTransport, so tests and `--fixtures=<dir>` replay
// recorded Messages API responses through the exact same code path as production, with no network.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export type Message = Anthropic.Message;
export type CreateParams = Anthropic.MessageCreateParamsNonStreaming;
export type CallKind = "research" | "extract";

export interface CallContext {
  /** `CO/carnaval-barranquilla` for a festival, `onboard/PE` for an onboarding run. */
  key: string;
  kind: CallKind;
}

export interface MessagesTransport {
  create(params: CreateParams, ctx: CallContext): Promise<Message>;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export function modelFromEnv(env: NodeJS.ProcessEnv): string {
  return env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

/** Real API. Credentials come from the environment (ANTHROPIC_API_KEY in CI, `op run` locally). */
export function anthropicTransport(client: Anthropic = new Anthropic()): MessagesTransport {
  return { create: (params) => client.messages.create(params) };
}

export interface RecordedCall {
  ctx: CallContext;
  params: CreateParams;
}

export interface FixtureSet {
  research: Message[];
  extract: Message[];
}

export class FixtureMissingError extends Error {
  constructor(key: string, kind: CallKind, index: number) {
    super(`no recorded ${kind} response #${index + 1} for ${key}`);
    this.name = "FixtureMissingError";
  }
}

export interface ReplayTransport extends MessagesTransport {
  calls: RecordedCall[];
}

/** Serves recorded responses per key and kind, in order, and records every request it gets. */
export function replayTransport(fixtures: ReadonlyMap<string, FixtureSet> | Record<string, FixtureSet>): ReplayTransport {
  const byKey = fixtures instanceof Map ? fixtures : new Map(Object.entries(fixtures));
  const served = new Map<string, number>();
  const calls: RecordedCall[] = [];
  return {
    calls,
    create(params, ctx) {
      calls.push({ ctx, params: structuredClone(params) });
      const counter = `${ctx.key}#${ctx.kind}`;
      const index = served.get(counter) ?? 0;
      served.set(counter, index + 1);
      const message = byKey.get(ctx.key)?.[ctx.kind][index];
      if (!message) return Promise.reject(new FixtureMissingError(ctx.key, ctx.kind, index));
      return Promise.resolve(structuredClone(message));
    },
  };
}

/** Fixture file for a key: `<dir>/<cc>/<slug>.json` or `<dir>/onboard/<cc>.json` (lowercase). */
export function fixturePath(dir: string, key: string): string {
  const [head = "", tail = ""] = key.split("/");
  return head === "onboard" ? join(dir, "onboard", `${tail.toLowerCase()}.json`) : join(dir, head.toLowerCase(), `${tail}.json`);
}

/** Recorded file shape. `_note` documents the fixture and is ignored. */
interface FixtureFile {
  research?: unknown;
  extract?: unknown;
}

export function loadFixtureSet(path: string): FixtureSet {
  const raw = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  const asMessages = (v: unknown, field: string): Message[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${path}: "${field}" must be an array of Messages API responses`);
    for (const m of v) {
      if (!m || typeof m !== "object" || (m as { type?: unknown }).type !== "message") throw new Error(`${path}: "${field}" holds a non-message`);
    }
    return v as Message[];
  };
  return { research: asMessages(raw.research, "research"), extract: asMessages(raw.extract, "extract") };
}

/** `--fixtures=<dir>`: lazily loads the recorded file for each key it is asked about. */
export function fixtureDirTransport(dir: string): ReplayTransport {
  const sets = new Map<string, FixtureSet>();
  const inner = replayTransport(sets);
  return {
    calls: inner.calls,
    create(params, ctx) {
      if (!sets.has(ctx.key)) {
        const path = fixturePath(dir, ctx.key);
        sets.set(ctx.key, existsSync(path) ? loadFixtureSet(path) : { research: [], extract: [] });
      }
      return inner.create(params, ctx);
    },
  };
}

export type ApiFailure =
  | { kind: "fatal"; message: string }
  | { kind: "rate_limit"; message: string }
  | { kind: "connection"; message: string }
  | { kind: "api"; status: number | undefined; message: string }
  | { kind: "fixture"; message: string };

/**
 * Typed SDK errors, most specific first. APIConnectionError extends APIError, so it must be
 * checked before APIError or that branch is dead code. Auth/permission errors stop the run:
 * every later call would fail the same way. Anything else is rethrown.
 */
export function classifyApiError(error: unknown): ApiFailure {
  if (error instanceof FixtureMissingError) return { kind: "fixture", message: error.message };
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { kind: "fatal", message: `${error.status ?? ""} ${error.message}`.trim() };
  }
  if (error instanceof Anthropic.RateLimitError) return { kind: "rate_limit", message: error.message };
  if (error instanceof Anthropic.APIConnectionError) return { kind: "connection", message: error.message };
  if (error instanceof Anthropic.APIError) return { kind: "api", status: error.status, message: error.message };
  throw error;
}
