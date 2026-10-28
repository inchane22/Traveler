// H7 (prd-F13): the built pages carry exactly the Content-Security-Policy vite.config.ts declares.
// «Un control sin prueba en CI no cuenta»: `pnpm build` runs this after `vite build`.
//   node scripts/check-csp.ts [dist]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CSP } from "../vite.config.ts";
import { isMainModule } from "./lib/is-main.ts";

const ENTITIES: Record<string, string> = { "&#39;": "'", "&apos;": "'", "&quot;": '"', "&#34;": '"', "&amp;": "&" };

/** Every CSP meta tag of a page, with HTML entities decoded. */
export function cspMetas(html: string): string[] {
  const tags = html.match(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi) ?? [];
  return tags.map((tag) => {
    const content = /\bcontent=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return (content?.[1] ?? content?.[2] ?? "").replace(/&#39;|&apos;|&quot;|&#34;|&amp;/g, (e) => ENTITIES[e]!);
  });
}

/** Null when the page has exactly one CSP meta equal to `expected`; otherwise what is wrong. */
export function cspProblem(html: string, expected: string): string | null {
  const metas = cspMetas(html);
  if (metas.length === 0) return "no Content-Security-Policy meta tag";
  if (metas.length > 1) return `${metas.length} Content-Security-Policy meta tags`;
  return metas[0] === expected ? null : `CSP differs: «${metas[0]}»`;
}

export function main(dist = "dist"): number {
  const index = join(dist, "index.html");
  if (!existsSync(index)) {
    console.error(`check-csp: ${index} not found; run vite build first`);
    return 1;
  }
  // index.html is the app shell and must carry the declared CSP exactly. Other pages (offline.html,
  // served by the service worker) keep their own stricter policy but may not ship without one.
  const pages = readdirSync(dist).filter((f) => f.endsWith(".html"));
  const problems = pages.flatMap((page) => {
    const html = readFileSync(join(dist, page), "utf8");
    const problem = page === "index.html" ? cspProblem(html, CSP) : cspMetas(html).length === 1 ? null : "needs exactly one Content-Security-Policy meta tag";
    return problem ? [`${page}: ${problem}`] : [];
  });
  if (problems.length) {
    console.error(`check-csp: ${problems.join("\n")}`);
    return 1;
  }
  console.log(`check-csp: ${pages.length} page(s) carry the declared CSP.`);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) process.exit(main(process.argv[2]));
