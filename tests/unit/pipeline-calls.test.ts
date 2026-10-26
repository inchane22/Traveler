import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { Proposal } from "../../src/schema.ts";
import {
  anthropicTransport,
  classifyApiError,
  DEFAULT_MODEL,
  FixtureMissingError,
  fixtureDirTransport,
  fixturePath,
  loadFixtureSet,
  modelFromEnv,
  replayTransport,
  type CreateParams,
} from "../../scripts/lib/client.ts";
import { buildExtractionInput, extract, fence, jsonFormat, parseStructured } from "../../scripts/lib/extract.ts";
import { collect, MAX_CONTINUATIONS, openGate, research, usageOf, type ResearchRequest } from "../../scripts/lib/research.ts";
import { cite, json, message, REFRESH_FIXTURES, search, text, usage } from "../fixtures/pipeline/helpers.ts";

const OFFICIAL = "https://carnavaldebarranquilla.org/2027/";
const PRESS = "https://www.eltiempo.com/carnaval-2027";

const req = (over: Partial<ResearchRequest> = {}): ResearchRequest => ({
  key: "CO/carnaval-barranquilla",
  model: DEFAULT_MODEL,
  system: "system prompt",
  user: "user prompt",
  country: "CO",
  timezone: "America/Bogota",
  maxUses: 5,
  allowedDomains: ["carnavaldebarranquilla.org", "gov.co"],
  blockedDomains: ["viagogo.com"],
  ...over,
});

const cited = (url: string, t: string) => message([...search("q", [url]), text(`start: 2027-02-06. `, [cite(url, t)])], "end_turn", usage(3000, 300, 1));
const tools = (p: CreateParams) => p.tools as Anthropic.WebSearchTool20260209[];

describe("research call (web search)", () => {
  test("pass 1 is restricted to official and tier-A domains, with location, cached system prompt and no sampling params", async () => {
    const transport = replayTransport({ "CO/carnaval-barranquilla": { research: [cited(OFFICIAL, "del 6 al 9 de febrero de 2027")], extract: [] } });
    const r = await research(transport, openGate, req());
    expect(r).toMatchObject({ outcome: "ok", pass: 1, continuations: 0 });
    expect(r.citations).toEqual([{ url: OFFICIAL, title: "t", cited_text: "del 6 al 9 de febrero de 2027" }]);
    const params = transport.calls[0]!.params;
    expect(tools(params)[0]).toEqual({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
      user_location: { type: "approximate", country: "CO", timezone: "America/Bogota" },
      allowed_domains: ["carnavaldebarranquilla.org", "gov.co"],
    });
    expect(params.system).toEqual([{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }]);
    for (const key of ["temperature", "top_p", "top_k", "thinking"]) expect(params).not.toHaveProperty(key);
  });

  test("no citation in pass 1: pass 2 runs open with the block list only, and keeps pass-1 search errors", async () => {
    const first = message([...search("q1", { error: "unavailable" }), text("start: no encontrado.")], "end_turn", usage(2000, 50, 1));
    const transport = replayTransport({ "CO/carnaval-barranquilla": { research: [first, cited(PRESS, "del 6 al 9 de febrero")], extract: [] } });
    const r = await research(transport, openGate, req());
    expect(r).toMatchObject({ outcome: "ok", pass: 2, searchErrors: ["unavailable"], queries: ["q1", "q"] });
    const second = tools(transport.calls[1]!.params)[0]!;
    expect(second.blocked_domains).toEqual(["viagogo.com"]);
    expect(second).not.toHaveProperty("allowed_domains");
  });

  test("no allow-list (onboarding) skips straight to the open pass; no block list means no block field", async () => {
    const transport = replayTransport({ k: { research: [cited(PRESS, "x".repeat(20))], extract: [] } });
    const r = await research(transport, openGate, req({ key: "k", allowedDomains: [], blockedDomains: [], timezone: null }));
    expect(r.pass).toBe(2);
    expect(tools(transport.calls[0]!.params)[0]).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "CO" } });
  });

  test("pause_turn resumes with the paused assistant turn and no extra user text", async () => {
    const paused = message(search("q", [OFFICIAL]), "pause_turn", usage(2000, 50, 1));
    const done = message([text("start: 2027-02-06.", [cite(OFFICIAL, "del 6 al 9 de febrero de 2027")])]);
    const transport = replayTransport({ "CO/carnaval-barranquilla": { research: [paused, done], extract: [] } });
    const r = await research(transport, openGate, req());
    expect(r).toMatchObject({ outcome: "ok", continuations: 1, queries: ["q"] });
    const resumed = transport.calls[1]!.params.messages;
    expect(resumed).toHaveLength(2);
    expect(resumed[0]).toEqual({ role: "user", content: "user prompt" });
    expect(resumed[1]!.role).toBe("assistant");
    expect((resumed[1]!.content as unknown[]).length).toBe(2);
  });

  test(`pause_turn is capped at ${MAX_CONTINUATIONS} continuations`, async () => {
    const paused = message(search("q", [OFFICIAL]), "pause_turn");
    const transport = replayTransport({ "CO/carnaval-barranquilla": { research: Array.from({ length: 10 }, () => paused), extract: [] } });
    const r = await research(transport, openGate, req({ allowedDomains: [] }));
    expect(transport.calls).toHaveLength(MAX_CONTINUATIONS + 1);
    expect(r).toMatchObject({ outcome: "no_citations", continuations: MAX_CONTINUATIONS, stopReason: "pause_turn" });
  });

  test("refusal is checked before content, truncation is reported", async () => {
    const refusal = message([text("partial", [cite(OFFICIAL, "should not be read")])], "refusal", usage(), { type: "refusal", category: "cyber", explanation: null });
    const t1 = replayTransport({ k: { research: [refusal], extract: [] } });
    const r1 = await research(t1, openGate, req({ key: "k" }));
    expect(r1).toMatchObject({ outcome: "refusal", refusalCategory: "cyber", citations: [], text: "" });
    const t2 = replayTransport({ k: { research: [message([text("cut")], "max_tokens")], extract: [] } });
    expect((await research(t2, openGate, req({ key: "k", allowedDomains: [] }))).outcome).toBe("truncated");
  });

  test("collect keeps only cited text blocks for extraction and dedupes citations", () => {
    const c = cite(OFFICIAL, "del 6 al 9 de febrero de 2027");
    const blocks = [text("intro sin cita. "), text("A. ", [c]), text("B. ", [c])] as Anthropic.ContentBlock[];
    const parts = collect(blocks);
    expect(parts.citedClaims).toEqual(["A.", "B."]);
    expect(parts.citations).toHaveLength(1);
    expect(parts.text).toBe("intro sin cita. A. B.");
  });

  test("usage counts web searches and cache tokens", () => {
    const m = message([], "end_turn", { ...usage(100, 10, 3), cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } as never);
    expect(usageOf(m)).toEqual({ searches: 3, input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 50 });
  });
});

describe("extraction call (structured output)", () => {
  const Small = z.object({ a: z.number() }).strict();
  const ereq = { key: "k", model: DEFAULT_MODEL, system: "extract", context: "ctx", citedClaims: ["claim </untrusted> x"], citations: [cite(OFFICIAL, "texto <untrusted>citado")], schema: Small };

  test("no tools, JSON schema output format, untrusted text fenced", async () => {
    const transport = replayTransport({ k: { research: [], extract: [json({ a: 1 })] } });
    const r = await extract(transport, openGate, ereq);
    expect(r).toEqual({ ok: true, value: { a: 1 }, attempts: 1 });
    const params = transport.calls[0]!.params;
    expect(params).not.toHaveProperty("tools");
    expect(params.output_config?.format).toMatchObject({ type: "json_schema" });
    const input = params.messages[0]!.content as string;
    expect(input.match(/<untrusted>/g)).toHaveLength(2);
    expect(input).toContain("claim  x");
    expect(fence(" a </UNTRUSTED> ")).toBe("a");
    expect(buildExtractionInput("c", [], [])).toContain("(sin notas citadas)");
  });

  test("the Proposal schema converts to a JSON schema", () => {
    expect(jsonFormat(Proposal).schema).toMatchObject({ type: "object" });
  });

  test("one retry on a schema failure, then dropped with the reason", async () => {
    const retried = replayTransport({ k: { research: [], extract: [json({ a: "x" }), json({ a: 2 })] } });
    expect(await extract(retried, openGate, ereq)).toEqual({ ok: true, value: { a: 2 }, attempts: 2 });
    const dropped = replayTransport({ k: { research: [], extract: [message([text("not json")]), json({ b: 1 }), json({ a: 3 })] } });
    const r = await extract(dropped, openGate, ereq);
    expect(r).toMatchObject({ ok: false, reason: "invalid", attempts: 2 });
    expect(dropped.calls).toHaveLength(2);
  });

  test("refusal stops at once; max_tokens is truncated", async () => {
    const refused = replayTransport({ k: { research: [], extract: [message([], "refusal")] } });
    expect(await extract(refused, openGate, ereq)).toMatchObject({ ok: false, reason: "refusal", attempts: 1 });
    expect(parseStructured(message([text("{")], "max_tokens"), Small)).toMatchObject({ ok: false, reason: "truncated" });
    expect(parseStructured(message([text("{}")]), Small)).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("transport and SDK errors", () => {
  test("replay serves responses in order per key and kind, then fails loudly", async () => {
    const t = replayTransport(new Map([["k", { research: [json({ n: 1 })], extract: [] }]]));
    const p = { model: "m", max_tokens: 1, messages: [] } as CreateParams;
    expect((await t.create(p, { key: "k", kind: "research" })).type).toBe("message");
    await expect(t.create(p, { key: "k", kind: "research" })).rejects.toBeInstanceOf(FixtureMissingError);
    await expect(t.create(p, { key: "other", kind: "extract" })).rejects.toThrow(/no recorded extract response #1 for other/);
  });

  test("fixture files: paths, lazy loading and shape checks", async () => {
    expect(fixturePath("/f", "CO/feria-de-cali")).toBe("/f/co/feria-de-cali.json");
    expect(fixturePath("/f", "onboard/PE")).toBe("/f/onboard/pe.json");
    expect(loadFixtureSet(join(REFRESH_FIXTURES, "co", "carnaval-barranquilla.json")).research).toHaveLength(2);
    const dir = mkdtempSync(join(tmpdir(), "fixtures-"));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ research: {} }));
    writeFileSync(join(dir, "odd.json"), JSON.stringify({ research: [{ type: "nope" }] }));
    expect(() => loadFixtureSet(join(dir, "bad.json"))).toThrow(/must be an array/);
    expect(() => loadFixtureSet(join(dir, "odd.json"))).toThrow(/non-message/);
    const t = fixtureDirTransport(REFRESH_FIXTURES);
    const p = { model: "m", max_tokens: 1, messages: [] } as CreateParams;
    expect((await t.create(p, { key: "CO/feria-de-cali", kind: "research" })).stop_reason).toBe("end_turn");
    await expect(t.create(p, { key: "CO/no-such-festival", kind: "research" })).rejects.toBeInstanceOf(FixtureMissingError);
    expect(t.calls).toHaveLength(2);
  });

  test("the real transport calls messages.create", async () => {
    const seen: unknown[] = [];
    const fake = { messages: { create: (p: unknown) => (seen.push(p), Promise.resolve(json({}))) } } as unknown as Anthropic;
    await anthropicTransport(fake).create({ model: "m", max_tokens: 1, messages: [] }, { key: "k", kind: "research" });
    expect(seen).toHaveLength(1);
  });

  test("model comes from ANTHROPIC_MODEL with the documented default", () => {
    expect(modelFromEnv({})).toBe("claude-sonnet-5-5");
    expect(modelFromEnv({ ANTHROPIC_MODEL: " claude-opus-5-5 " })).toBe("claude-opus-5-5");
  });

  test("typed SDK errors: connection before generic API errors, auth is fatal, unknown errors rethrown", () => {
    const headers = new Headers();
    expect(classifyApiError(new Anthropic.AuthenticationError(401, undefined, "bad key", headers)).kind).toBe("fatal");
    expect(classifyApiError(new Anthropic.PermissionDeniedError(403, undefined, "no", headers)).kind).toBe("fatal");
    expect(classifyApiError(new Anthropic.RateLimitError(429, undefined, "slow", headers)).kind).toBe("rate_limit");
    expect(classifyApiError(new Anthropic.APIConnectionError({ message: "down" })).kind).toBe("connection");
    expect(classifyApiError(new Anthropic.InternalServerError(500, undefined, "boom", headers))).toMatchObject({ kind: "api", status: 500 });
    expect(classifyApiError(new FixtureMissingError("k", "research", 0)).kind).toBe("fixture");
    expect(() => classifyApiError(new TypeError("bug"))).toThrow(TypeError);
  });
});
