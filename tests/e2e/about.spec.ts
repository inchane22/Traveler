// Sobre los datos: the change log speaks the UI language (code-F10, ux-F13). No slugs, field ids
// or Spanish enum codes reach the screen; the festival name links to its ficha.
import { expect, test } from "@playwright/test";
import { open } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

// Enum codes as stored. Unit codes (tourists, visitors) are left out: they are plain English words.
const RAW_CODES = new Set(["confirmada", "tentativa", "por_anunciar", "aplazada", "cancelada", "oficial", "prensa", "patron", "estimacion", "mayoria_gratis", "mixta", "mayoria_boleta", "unesco", "nacional", "ninguna", "internacional", "ninguno", "pueblo", "intermedia", "gran_ciudad", "baile_abierto", "baile_y_show", "show", "solemne", "regional", "about", "exact", "more_than"]);
const FIELD_IDS = new Set(["start", "end", "status", "confidence", "note"]);

for (const lang of ["es", "en", "pt"] as const) {
  test(`the change log names festivals and fields in words (${lang})`, async ({ page }) => {
    await page.addInitScript((l) => {
      try {
        localStorage.setItem("traveler.lang", JSON.stringify(l));
      } catch {
        /* Spanish then */
      }
    }, lang);
    await open(page, "#/datos");
    const items = page.locator(".log__item");
    expect(await items.count()).toBeGreaterThan(5);
    for (const name of await page.locator(".log__what a").allInnerTexts()) expect(name).not.toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)+$/); // a slug such as feria-de-cali
    for (const field of await page.locator(".log__field").allInnerTexts()) {
      expect(field).not.toMatch(/key_events|score\.|^[a-z_]+(?:\.[a-z0-9_-]+)+$/);
      expect(FIELD_IDS.has(field.trim()), field).toBe(false);
    }
    for (const change of await page.locator(".log__change").allInnerTexts()) {
      for (const side of change.split("→").map((s) => s.trim())) expect(RAW_CODES.has(side), change).toBe(false);
    }
    await expect(page.locator(".log__what a").first()).toHaveAttribute("href", /^#\/fiesta\/[a-z0-9-]+$/);
  });
}

test("the latest 10 changes stay in view and older ones fold behind one disclosure", async ({ page }) => {
  await open(page, "#/datos");
  const total = await page.locator(".log__item").count();
  expect(total).toBeGreaterThan(10);
  await expect(page.getByTestId("log-latest").locator(".log__item")).toHaveCount(10);
  const toggle = page.locator(".log-more__toggle");
  await expect(toggle).toHaveText(`Ver ${Math.min(total, 50) - 10} cambios anteriores`);
  await expect(page.locator(".log-more .log__item").first()).toBeHidden();
  await toggle.click();
  await expect(page.locator(".log-more .log__item").first()).toBeVisible();
});

test("«En esta página» jumps to a section and moves focus to its heading", async ({ page }) => {
  await open(page, "#/datos");
  const nav = page.getByRole("navigation", { name: "En esta página" });
  await expect(nav.getByRole("button")).toHaveText(["Puntaje", "Marcas", "Frescura", "Cambios"]);
  await nav.getByRole("button", { name: "Cambios" }).click();
  await expect(page.getByRole("heading", { name: "Registro de cambios" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Registro de cambios" })).toBeInViewport();
  await expect(page).toHaveURL(/#\/datos$/);
});
