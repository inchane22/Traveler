// Shared e2e helpers. Every spec pins the clock with ?today= (docs/architecture.md, runtime hooks)
// so countdowns and «Lo próximo» are deterministic against the committed data.
import { expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

export const TODAY = "2026-10-26";

export const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Opens a hash route with the pinned date and waits until data has rendered. */
export async function open(page: Page, hash = "#/", today = TODAY): Promise<void> {
  await page.goto(`/?today=${today}${hash}`);
  await settled(page);
}

/** The screen is mounted and no part of it is still showing a skeleton. */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator("main .screen")).toBeVisible();
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}

/** Clicks and returns the text of the file the click downloads. */
export async function downloadText(page: Page, target: Locator): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), target.click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: await readFile(path, "utf8") };
}

/** The visible navigation (bottom bar on phones, top bar on desktop). */
export function nav(page: Page): Locator {
  return page.locator(".bottomnav:visible, .topnav:visible").first();
}

/**
 * Explorar's country, month, type, Nivel 2 and sort chips: a sheet on phones (drafted, applied with
 * «Ver N fiestas»), inline on desktop (applied at once). Opens the sheet when the panel is hidden.
 */
export async function openFilters(page: Page): Promise<void> {
  const button = page.locator('[data-key="filters-open"]');
  if (await button.isVisible()) {
    await button.click();
    await expect(page.getByRole("dialog", { name: "Filtros" })).toBeVisible();
  }
}

/** The visible set of filter chips: the open sheet on phones, the inline panel on desktop. */
export function filterChips(page: Page): Locator {
  return page.locator("dialog[open] .filter-sheet, .filters__panel").filter({ visible: true }).first();
}

/** Applies the sheet's draft on phones; on desktop the chips already applied. */
export async function applyFilters(page: Page): Promise<void> {
  const apply = page.getByTestId("filters-apply");
  if (await apply.isVisible()) await apply.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await settled(page);
}

/** Unfolds RFC 5545 continuation lines so assertions can match whole properties. */
export function unfold(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, "");
}
