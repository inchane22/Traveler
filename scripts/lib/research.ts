// Call 1 (research): Messages API + web_search, restricted to official/tier-A domains first (R7),
// opened with blocked domains only when the first pass yields no citation.
import type Anthropic from "@anthropic-ai/sdk";
import type { CallContext, CreateParams, Message, MessagesTransport } from "./client.ts";

export interface Citation {
  url: string;
  title: string | null;
  cited_text: string;
}

export interface CallUsage {
  searches: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Budget hook around every API call (R10). `beforeCall` throws to stop the run. */
export interface CallGate {
  beforeCall(ctx: CallContext): void;
  afterCall(ctx: CallContext, usage: CallUsage): void;
}

export const openGate: CallGate = { beforeCall: () => {}, afterCall: () => {} };

export type ResearchOutcome = "ok" | "no_citations" | "refusal" | "truncated";

export interface ResearchResult {
  outcome: ResearchOutcome;
  pass: 1 | 2;
  /** All text the model wrote. */
  text: string;
  /** Only the text blocks that carry citations: what the extraction call may see. */
  citedClaims: string[];
  citations: Citation[];
  queries: string[];
  searchErrors: string[];
  stopReason: Message["stop_reason"];
  refusalCategory: string | null;
  continuations: number;
}

export interface ResearchRequest {
  key: string;
  model: string;
  system: string;
  user: string;
  country: string;
  timezone: string | null;
  maxUses: number;
  /** Pass 1 allow-list (official + tier A). Empty skips straight to the open pass. */
  allowedDomains: readonly string[];
  /** Pass 2 block-list (config/sources/<cc>.json). */
  blockedDomains: readonly string[];
  maxTokens?: number;
}

export const MAX_CONTINUATIONS = 5;

export function usageOf(message: Message): CallUsage {
  const u = message.usage;
  return {
    searches: u.server_tool_use?.web_search_requests ?? 0,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

function webSearchTool(req: ResearchRequest, pass: 1 | 2): Anthropic.WebSearchTool20260209 {
  const location: Anthropic.UserLocation = { type: "approximate", country: req.country, ...(req.timezone ? { timezone: req.timezone } : {}) };
  const base: Anthropic.WebSearchTool20260209 = { type: "web_search_20260209", name: "web_search", max_uses: req.maxUses, user_location: location };
  // allowed_domains and blocked_domains are mutually exclusive on the tool.
  if (pass === 1) return { ...base, allowed_domains: [...req.allowedDomains] };
  return req.blockedDomains.length ? { ...base, blocked_domains: [...req.blockedDomains] } : base;
}

export function buildResearchParams(req: ResearchRequest, pass: 1 | 2): CreateParams {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 16000,
    // Stable instructions first and cached; the festival-specific part goes in the user turn.
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    tools: [webSearchTool(req, pass)],
    messages: [{ role: "user", content: req.user }],
  };
}

/** Collects the pieces of a (possibly resumed) research turn. Pure. */
export function collect(content: readonly Anthropic.ContentBlock[]): Pick<ResearchResult, "text" | "citedClaims" | "citations" | "queries" | "searchErrors"> {
  const texts: string[] = [];
  const citedClaims: string[] = [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const queries: string[] = [];
  const searchErrors: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text);
      const located = (block.citations ?? []).filter((c): c is Anthropic.CitationsWebSearchResultLocation => c.type === "web_search_result_location");
      if (located.length) citedClaims.push(block.text.trim());
      for (const c of located) {
        const id = `${c.url}\u0000${c.cited_text}`;
        if (seen.has(id)) continue;
        seen.add(id);
        citations.push({ url: c.url, title: c.title, cited_text: c.cited_text });
      }
    } else if (block.type === "server_tool_use" && block.name === "web_search") {
      const q = (block.input as { query?: unknown } | null)?.query;
      if (typeof q === "string") queries.push(q);
    } else if (block.type === "web_search_tool_result" && !Array.isArray(block.content)) {
      // Error results arrive as an object, not a list (HTTP 200, no exception).
      searchErrors.push(block.content.error_code);
    }
  }
  return { text: texts.join("").trim(), citedClaims, citations, queries, searchErrors };
}

async function runPass(transport: MessagesTransport, gate: CallGate, req: ResearchRequest, pass: 1 | 2): Promise<ResearchResult> {
  const ctx: CallContext = { key: req.key, kind: "research" };
  const params = buildResearchParams(req, pass);
  const content: Anthropic.ContentBlock[] = [];
  let continuations = 0;
  for (;;) {
    gate.beforeCall(ctx);
    const message = await transport.create(params, ctx);
    gate.afterCall(ctx, usageOf(message));
    const empty = { text: "", citedClaims: [], citations: [], queries: [], searchErrors: [] };
    if (message.stop_reason === "refusal") {
      return { outcome: "refusal", pass, ...empty, stopReason: message.stop_reason, refusalCategory: message.stop_details?.category ?? null, continuations };
    }
    content.push(...message.content);
    if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
      return { outcome: "truncated", pass, ...empty, stopReason: message.stop_reason, refusalCategory: null, continuations };
    }
    if (message.stop_reason === "pause_turn" && continuations < MAX_CONTINUATIONS) {
      continuations += 1;
      // The paused assistant turn goes back as-is and the server resumes it; no extra user text.
      // Response blocks are accepted as params by the API; the SDK types them separately.
      params.messages = [params.messages[0]!, { role: "assistant", content: content as unknown as Anthropic.ContentBlockParam[] }];
      continue;
    }
    const parts = collect(content);
    return {
      outcome: parts.citations.length ? "ok" : "no_citations",
      pass,
      ...parts,
      stopReason: message.stop_reason,
      refusalCategory: null,
      continuations,
    };
  }
}

/** Pass 1 restricted to official + tier-A domains; pass 2 only when pass 1 found no citation. */
export async function research(transport: MessagesTransport, gate: CallGate, req: ResearchRequest): Promise<ResearchResult> {
  if (!req.allowedDomains.length) return runPass(transport, gate, req, 2);
  const first = await runPass(transport, gate, req, 1);
  if (first.outcome !== "no_citations") return first;
  const second = await runPass(transport, gate, req, 2);
  // Keep what pass 1 tried, so the run log shows a failed restricted search too.
  return { ...second, queries: [...first.queries, ...second.queries], searchErrors: [...first.searchErrors, ...second.searchErrors] };
}
