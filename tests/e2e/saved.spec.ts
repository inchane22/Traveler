// RF-09 Guardadas and RF-11 language: save two festivals, switch to English without a reload,
// both are in Saved; export all of them to one .ics.
import { expect, test } from "@playwright/test";
import { downloadText, nav, open, settled, unfold } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test.describe("Guardadas and language", () => {
  test("RF-09/RF-11: save two, switch to English without reloading, both appear in Saved", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    await page.getByRole("button", { name: "Guardar Carnaval de Barranquilla" }).click();
    await page.getByRole("button", { name: "Guardar Feria de Cali" }).click();
    await expect(page.getByRole("button", { name: "Guardar Carnaval de Barranquilla" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#live")).toContainText("guardada");

    await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
    await nav(page).getByRole("link", { name: "Ajustes" }).click();
    await settled(page);
    await page.getByLabel("English").check();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
    await expect(page.getByLabel("English")).toBeFocused();

    await nav(page).getByRole("link", { name: /^Saved/ }).click();
    await settled(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
    const list = page.getByTestId("saved-list");
    await expect(list.locator("[data-slug]")).toHaveCount(2);
    await expect(list.locator("[data-slug]").first()).toHaveAttribute("data-slug", "feria-de-cali");
    await expect(list.locator("[data-slug]").nth(1)).toHaveAttribute("data-slug", "carnaval-barranquilla");
    expect(await page.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  });

  test("RF-09: saved festivals survive a reload and export to one .ics", async ({ page }) => {
    await open(page, "#/fiesta/carnaval-barranquilla");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Guardada" })).toHaveAttribute("aria-pressed", "true");
    await open(page, "#/fiesta/feria-de-cali");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();

    await page.reload();
    await open(page, "#/guardadas");
    await expect(page.getByTestId("saved-count")).toHaveText("2 fiestas guardadas");
    const { name, text } = await downloadText(page, page.getByRole("button", { name: /Exportar/ }));
    expect(name).toBe("traveler-guardadas.ics");
    const ics = unfold(text);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20270206");
  });

  test("an empty Guardadas offers a way to find festivals", async ({ page }) => {
    await open(page, "#/guardadas");
    await page.getByRole("link", { name: "Explorar fiestas" }).click();
    await expect(page).toHaveURL(/#\/explorar/);
  });

  test("the language comes from the browser the first time", async ({ browser }) => {
    const context = await browser.newContext({ locale: "pt-BR", serviceWorkers: "block" });
    const page = await context.newPage();
    await open(page, "#/ajustes");
    await expect(page.locator("html")).toHaveAttribute("lang", "pt");
    await expect(page.getByLabel("Português")).toBeChecked();
    await context.close();
  });

  test("the first day of the week changes the month grid", async ({ page }) => {
    await open(page, "#/ajustes");
    await page.getByLabel("Lunes").check();
    await open(page, "#/fiesta/carnaval-barranquilla");
    await expect(page.locator(".mg-head").first()).toHaveText("L");
  });
});

test("UI-2: a saved pending postponement says a new date is coming, not that it ended", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("traveler.saved", JSON.stringify(["petronio-alvarez"])));
  await open(page, "#/guardadas");
  const row = page.getByTestId("saved-list").locator('[data-slug="petronio-alvarez"]');
  await expect(row).toContainText("Nueva fecha por anunciar");
  await expect(row).toContainText("Fecha original: 1–31 ago 2026");
  await expect(row).not.toContainText("Ya terminó");
  await expect(row).not.toContainText("Ventana probable");
});
