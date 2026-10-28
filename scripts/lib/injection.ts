// R7 / LLM01: flags citation text that tries to instruct the model. A hit never auto-applies a
// change; it only routes it to a human with the phrase that triggered it.

/** Patterns over accent-free lowercase text, es/en/pt plus prompt-format markers. */
const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["ignora", /\bignora(r|d)?\b/],
  ["ignore previous", /\bignore (all |any |the |your )*(previous|prior|above|earlier|preceding|former)\b/],
  ["ignore instructions", /\bignor(e|a|ar|em)( as| las| todas( as| las)?| all| the| your)* (instructions|instrucciones|instrucoes)\b/],
  ["disregard", /\bdisregard\b/],
  ["desconsidere", /\bdesconsider(e|a|ar)\b/],
  ["haz caso omiso", /\bhaz caso omiso\b/],
  ["forget instructions", /\b(forget|olvida|olvide|esqueca|esquece)( as| las| todas( as| las)?| all| the| your| previous| prior)* (instructions|instrucciones|instrucoes)\b/],
  ["previous instructions", /\b(previous|prior) instructions\b|\binstrucciones (anteriores|previas)\b|\binstrucoes anteriores\b/],
  ["new instructions", /\bnew instructions\b|\bnuevas instrucciones\b|\bnovas instrucoes\b/],
  ["system prompt", /\bsystem prompt\b|\bprompt (del|de|do) sistema\b/],
  ["you are now", /\byou are now\b|\bahora eres\b|\beres ahora\b|\bvoce agora e\b|\bagora voce e\b/],
  ["developer mode", /\bdeveloper mode\b|\bjailbreak\b/],
  ["role marker", /<\|[a-z_]+\|>|\[\/?inst\]|^\s*(system|assistant)\s*:|#{2,}\s*(system|instruction)/m],
];

export interface InjectionHit {
  phrase: string;
  excerpt: string;
}

/**
 * Accent-free lowercase that keeps line breaks, so the role-marker pattern can see line starts.
 * Invisible format characters (soft hyphen, zero-width, tags) are dropped so they cannot split a
 * phrase (BE-06).
 */
function foldLines(text: string): string {
  return text.normalize("NFD").replace(/[\p{M}\p{Cf}]+/gu, "").toLowerCase().replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n");
}

/** Phrases found in `text`; empty when clean. Each pattern is tried on one line and across lines. */
export function detectInjection(text: string): InjectionHit[] {
  const lined = foldLines(text);
  const flat = lined.replace(/\n/g, " ");
  const hits: InjectionHit[] = [];
  for (const [phrase, re] of PATTERNS) {
    const source = re.test(flat) ? flat : lined;
    const m = re.exec(source);
    if (!m) continue;
    const from = Math.max(0, m.index - 30);
    hits.push({ phrase, excerpt: source.slice(from, m.index + m[0].length + 30) });
  }
  return hits;
}

export function hasInjection(texts: readonly string[]): InjectionHit[] {
  return texts.flatMap((t) => detectInjection(t));
}
