// Service worker (production build only): the shell and the last JSON of a visited country work
// offline; data is network-first so a reconnect always shows fresh dates.
import { expect, test } from "@playwright/test";
import { open, settled, TODAY } from "./helpers.ts";

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

const controlled = (page: import("@playwright/test").Page) => () => page.evaluate(() => !!navigator.serviceWorker.controller);

/** True once the worker's data cache holds every one of these paths. */
const dataCached = (page: import("@playwright/test").Page, paths: string[]) => () =>
  page.evaluate(async (wanted) => {
    const names = (await caches.keys()).filter((n) => n.startsWith("traveler-data-"));
    const urls = (await Promise.all(names.map(async (n) => (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname)))).flat();
    return wanted.every((p) => urls.includes(p));
  }, paths);

// ux-F02: the first visit loads its data before the worker controls the page; the worker must
// still end up with that data, and the cached CSS must match the page's requests (Vary: Origin).
test("after exactly one visit the country opens offline, styled", async ({ page, context }) => {
  await open(page, "#/pais/co");
  await expect.poll(controlled(page)).toBe(true);
  await expect.poll(dataCached(page, ["/data/index.json", "/data/countries/co.json"])).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await settled(page);
  await expect(page.getByTestId("next-festival")).toContainText("Cartagena");
  await expect(page.locator(".notice--offline")).toBeVisible();
  expect(await page.locator(".masthead").evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  await context.setOffline(false);
});

// SEC-03: opening a data file as a page must not replace the cached app shell.
test("a data file opened as a page does not replace the offline shell", async ({ page, context }) => {
  await open(page, "#/pais/co");
  await expect.poll(controlled(page)).toBe(true);
  await expect.poll(dataCached(page, ["/data/countries/co.json"])).toBe(true);
  const json = await page.goto("/data/index.json");
  expect(json?.headers()["content-type"]).toContain("application/json");

  await context.setOffline(true);
  const shell = await page.goto(`/?today=${TODAY}#/pais/co`);
  expect(shell?.headers()["content-type"]).toContain("text/html");
  await settled(page);
  await expect(page.getByTestId("next-festival")).toContainText("Cartagena");
  await context.setOffline(false);
});

// prd-F21: the last-resort offline page is static, script-free and built from locales/.
test("the static offline page speaks every UI language and runs no script", async ({ request }) => {
  const res = await request.get("/offline.html");
  expect(res.ok()).toBe(true);
  const html = await res.text();
  for (const text of ["Sin conexión", "You're offline", "Sem conexão"]) expect(html).toContain(text);
  expect(html).not.toMatch(/<script/i);
});
