// RF-14: «Cerca de mí» is optional, asked only after an explicit tap, kept in memory only, and sorts
// Explorar by distance. A refusal leaves everything else working.
import { expect, test, type Page } from "@playwright/test";
import { open, settled } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

const BOGOTA = { latitude: 4.711, longitude: -74.072 };

/** Kilometres shown on each «A N km» tag, in list order. */
async function distances(page: Page): Promise<number[]> {
  const tags = page.getByTestId("results").locator(".fest-list--near .tag", { hasText: /km$/ });
  await expect(tags.first()).toBeVisible();
  return (await tags.allTextContents()).map((text) => Number(text.replace(/\D/g, "")));
}

/** In-app navigation: the location lives in memory, so a reload would forget it by design. */
async function goInApp(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    location.hash = next;
  }, hash);
  await settled(page);
}

test.describe("RF-14 with permission", () => {
  test.use({ geolocation: BOGOTA, permissions: ["geolocation"] });

  test("the location is asked only after a tap, then Explorar sorts by distance", async ({ page }) => {
    await open(page, "#/ajustes");
    await expect(page.locator(".setting__state")).toHaveCount(0);
    await page.getByRole("button", { name: "Usar mi ubicación" }).click();
    await expect(page.locator(".setting__state")).toHaveText(/Ubicación lista/);
    await expect(page.getByRole("link", { name: "Ver fiestas cerca" })).toHaveAttribute("href", /orden=cerca/);

    await goInApp(page, "#/explorar?pais=co&orden=cerca");
    // The sort control: inline on desktop, in the filter sheet on phones (the state is the same).
    await expect(page.locator('[data-key="sort-near"]')).toHaveAttribute("aria-pressed", "true");
    const km = await distances(page);
    expect(km.length).toBeGreaterThan(3);
    expect(km).toEqual([...km].sort((a, b) => a - b));
  });

  test("«Olvidar mi ubicación» drops it and Explorar asks again", async ({ page }) => {
    await open(page, "#/ajustes");
    await page.getByRole("button", { name: "Usar mi ubicación" }).click();
    await expect(page.locator(".setting__state")).toBeVisible();
    await page.getByRole("button", { name: "Olvidar mi ubicación" }).click();
    await expect(page.getByRole("button", { name: "Usar mi ubicación" })).toBeVisible();

    await goInApp(page, "#/explorar?pais=co&orden=cerca");
    await expect(page.locator(".empty")).toContainText("hace falta tu ubicación");
  });

  test("the sort control in Explorar asks for the location in place", async ({ page }) => {
    await open(page, "#/explorar?pais=co&orden=cerca");
    await page.locator(".empty").getByRole("button", { name: "Usar mi ubicación" }).click();
    const km = await distances(page);
    expect(km).toEqual([...km].sort((a, b) => a - b));
  });
});

test.describe("RF-14 without permission", () => {
  test("a refusal explains itself and the rest of Ajustes still works", async ({ page, context }) => {
    await context.clearPermissions();
    await open(page, "#/ajustes");
    await page.getByRole("button", { name: "Usar mi ubicación" }).click();
    await expect(page.getByText("No diste permiso para usar tu ubicación")).toBeVisible();
    await expect(page.locator(".setting__state")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ajustes");
  });
});
