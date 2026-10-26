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

/** Unfolds RFC 5545 continuation lines so assertions can match whole properties. */
export function unfold(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, "");
}
