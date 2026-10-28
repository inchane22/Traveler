// WCAG 2.2 SC 2.4.11 Focus Not Obscured (axe does not test it): a control reached with Tab is
// never hidden behind the fixed bottom nav, the sticky action bar, the sticky Explorar summary or
// the masthead. Runs in both projects: phones have the bottom nav, desktop only the action bar.
import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

const CHROME = [".masthead", ".bottomnav", ".actionbar", ".summary"];

interface Hit {
  bar: string;
  text: string;
  top: number;
  bottom: number;
  barTop: number;
  barBottom: number;
}

/** The fixed or sticky bar the focused element overlaps, if any (bars never hide their own controls). */
async function obscuredBy(page: Page): Promise<Hit | null> {
  return page.evaluate(async (selectors) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    for (const sel of selectors) {
      const bar = document.querySelector<HTMLElement>(sel);
      if (!bar || bar.contains(el)) continue;
      const style = getComputedStyle(bar);
      if (style.display === "none" || (style.position !== "fixed" && style.position !== "sticky")) continue;
      const b = bar.getBoundingClientRect();
      const top = Math.max(r.top, b.top);
      const bottom = Math.min(r.bottom, b.bottom);
      const left = Math.max(r.left, b.left);
      const right = Math.min(r.right, b.right);
      if (bottom - top <= 1 || right - left <= 1) continue;
      // Overlap only counts when the bar is painted on top (the skip link sits above the masthead).
      const painted = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (painted && bar.contains(painted)) return { bar: sel, text: (el.textContent ?? "").trim().slice(0, 40), top: r.top, bottom: r.bottom, barTop: b.top, barBottom: b.bottom };
    }
    return null;
  }, CHROME);
}

async function tabWalk(page: Page, presses: number): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    const hit = await obscuredBy(page);
    if (hit) hits.push(hit);
  }
  return hits;
}

for (const [label, hash, presses] of [
  ["Ficha", "#/fiesta/carnaval-barranquilla", 45],
  ["Explorar", "#/explorar?pais=co", 60],
  ["Inicio (país)", "#/pais/co", 30],
] as const) {
  test(`2.4.11: Tab through ${label} never lands behind sticky chrome`, async ({ page }) => {
    await open(page, hash);
    expect(await tabWalk(page, presses)).toEqual([]);
  });
}

// ux-F06, WCAG 1.4.10 Reflow: at 320 × 256 CSS px (1280 × 1024 at 400%) the bars scroll with the
// page instead of covering most of it.
for (const hash of ["#/fiesta/carnaval-barranquilla", "#/explorar?pais=co"]) {
  test(`1.4.10: at 320 × 256 the sticky chrome leaves the screen to content (${hash})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 256 });
    await open(page, hash);
    await page.mouse.wheel(0, 800);
    const covered = await page.evaluate((selectors) => {
      let sum = 0;
      for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || (style.position !== "fixed" && style.position !== "sticky")) continue;
        sum += el.getBoundingClientRect().height;
      }
      return sum;
    }, CHROME);
    expect(covered).toBeLessThanOrEqual(256 * 0.25);
  });
}
