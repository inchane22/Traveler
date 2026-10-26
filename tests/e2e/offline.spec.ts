// Service worker (production build only): the shell and the last JSON of a visited country work
// offline; data is network-first so a reconnect always shows fresh dates.
import { expect, test } from "@playwright/test";
import { open, settled } from "./helpers.ts";

test.use({ serviceWorkers: "allow" });

test("a visited country still opens offline", async ({ page, context }) => {
  await open(page, "#/pais/co");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Second load runs under the worker, which caches the shell, assets and the country JSON.
  await page.reload();
  await settled(page);
  await expect(page.getByTestId("next-festival")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await settled(page);
  await expect(page.getByTestId("next-festival")).toContainText("Cartagena");
  await expect(page.locator(".notice--offline")).toBeVisible();
  await context.setOffline(false);
});
