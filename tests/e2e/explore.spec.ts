// Explorar: RF-03 chips with counts, URL state and Back; RF-04 «Mis fechas de viaje»; empty states.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { applyFilters, filterChips, open, openFilters, settled } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../..");

test.use({ serviceWorkers: "block" });

const count = (page: import("@playwright/test").Page) => page.getByTestId("result-count");

test.describe("Explorar", () => {
  test("RF-03: every chip shows its count", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    // The pressed country chip counts exactly the festivals listed for it (no literal: the data moves).
    const listed = await page.getByTestId("results").locator("[data-slug]").count();
    expect(listed).toBeGreaterThan(0);
    await expect(count(page)).toHaveText(`${listed} fiestas`);
    await openFilters(page);
    const chips = filterChips(page).locator(".chip");
    expect(await chips.count()).toBeGreaterThan(15);
    for (const chip of await chips.all()) await expect(chip.locator(".chip__count")).toHaveText(/\d+/);
    const colombia = filterChips(page).getByRole("button", { name: `Colombia (${listed} fiestas)` });
    await expect(colombia).toHaveAttribute("aria-pressed", "true");
    await expect(colombia.locator(".chip__count")).toHaveText(String(listed));
  });

  test("a chip that would give nothing is inert, never dashed, and says its 0", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    await openFilters(page);
    const zero = filterChips(page).locator(".chip--zero").first();
    await expect(zero).toHaveAttribute("aria-disabled", "true");
    await expect(zero).toHaveAccessibleName(/\(0 fiestas\)$/);
    expect(await zero.evaluate((el) => getComputedStyle(el).borderStyle)).toBe("solid");
    const url = page.url();
    // Playwright treats aria-disabled as disabled, so force the tap a person could still make.
    await zero.click({ force: true });
    await expect(zero).toHaveAttribute("aria-pressed", "false");
    expect(page.url()).toBe(url);
  });

  test("RF-03: filters live in the URL and Back restores them", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    await expect(count(page)).toHaveText(/\d+ fiestas/);
    const all = await count(page).textContent();

    await openFilters(page);
    await filterChips(page).getByRole("button", { name: /^Carnaval \(\d+ fiestas?\)$/ }).click();
    await applyFilters(page);
    await expect(page).toHaveURL(/#\/explorar\?pais=co&tipo=carnaval$/);
    await expect(page.locator('[data-key="tipo-carnaval"]')).toHaveAttribute("aria-pressed", "true");
    await expect(count(page)).not.toHaveText(all ?? "");
    const carnavalCount = await count(page).textContent();

    await openFilters(page);
    await filterChips(page).getByRole("button", { name: /^febrero de 2027/ }).click();
    await applyFilters(page);
    await expect(page).toHaveURL(/mes=2027-02/);
    await expect(page.getByTestId("results")).toContainText("Carnaval de Barranquilla");

    await page.goBack();
    await expect(page).toHaveURL(/#\/explorar\?pais=co&tipo=carnaval$/);
    await settled(page);
    await expect(page.locator('[data-key="mes-2027-02"]')).toHaveAttribute("aria-pressed", "false");
    await expect(count(page)).toHaveText(carnavalCount ?? "");

    await page.goBack();
    await expect(page).toHaveURL(/#\/explorar\?pais=co$/);
    await expect(count(page)).toHaveText(all ?? "");
  });

  test("RF-03: «Limpiar filtros» is always visible and clears everything in one tap", async ({ page }) => {
    await open(page, "#/explorar?pais=co&tipo=carnaval&nivel=2&desde=2027-01-01");
    const clear = page.getByRole("button", { name: "Limpiar filtros" });
    await page.mouse.wheel(0, 1500);
    await expect(clear).toBeInViewport();
    await clear.click();
    await expect(page).toHaveURL(/#\/explorar$/);
    await expect(page.getByRole("button", { name: "Limpiar filtros" })).toBeDisabled();
  });

  test("RF-03: the Nivel 2 switch shows its count and widens the list", async ({ page }) => {
    await open(page, "#/explorar");
    const before = Number((await count(page).textContent())?.match(/\d+/)?.[0]);
    await openFilters(page);
    const sw = filterChips(page).getByRole("switch", { name: /Incluir medianas \(Nivel 2\)/ });
    await expect(sw.locator(".chip__count")).toHaveText(/\d+/);
    await sw.click();
    await applyFilters(page);
    await expect(page).toHaveURL(/nivel=2/);
    await expect.poll(async () => Number((await count(page).textContent())?.match(/\d+/)?.[0])).toBeGreaterThan(before);
  });

  // Hybrid filters (phones): the sheet drafts with live counts and applies as one history entry.
  test("phones: the filter sheet drafts, counts live and applies as one Back step", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "the sheet is the phone layout");
    await open(page, "#/explorar?pais=co");
    const url = page.url();
    const length = await page.evaluate(() => history.length);
    await openFilters(page);
    const sheet = page.getByRole("dialog", { name: "Filtros" });
    await sheet.getByRole("button", { name: /^Carnaval \(/ }).click();
    await sheet.getByRole("button", { name: /^febrero de 2027/ }).click();
    expect(page.url(), "a draft does not navigate").toBe(url);
    await expect(sheet.getByTestId("filters-apply")).toHaveText("Ver 1 fiesta");
    // The live recount redraws the chips; focus stays on the one just tapped.
    await expect(sheet.locator('[data-key="sh-mes-2027-02"]')).toBeFocused();
    await applyFilters(page);
    await expect(page).toHaveURL(/#\/explorar\?pais=co&mes=2027-02&tipo=carnaval$/);
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await expect(page.locator('[data-key="filters-open"]')).toBeFocused();
    await expect(page.locator('[data-key="filters-open"]')).toHaveAccessibleName(/Filtros \(3 activos\)/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/explorar\?pais=co$/);
  });

  test("phones: closing the filter sheet discards the draft", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "the sheet is the phone layout");
    await open(page, "#/explorar?pais=co");
    const url = page.url();
    await openFilters(page);
    await page.getByRole("dialog").getByRole("button", { name: /^Carnaval \(/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect(page.locator('[data-key="filters-open"]')).toBeFocused();
  });

  test("phones: the list starts above the fold and active filters are removable in one tap", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "the sheet is the phone layout");
    await open(page, "#/explorar?pais=co&tipo=carnaval&nivel=2");
    await expect(page.getByTestId("results").locator("[data-slug]").first()).toBeInViewport();
    const active = page.getByRole("group", { name: "Filtros activos" });
    const names = await active.getByRole("button").evaluateAll((els) => els.map((el) => el.textContent?.trim()));
    expect(names).toEqual(["Quitar filtro: Colombia", "Quitar filtro: Carnaval", "Quitar filtro: Medianas (Nivel 2)"]);
    await active.getByRole("button", { name: "Quitar filtro: Carnaval" }).click();
    await expect(page).toHaveURL(/#\/explorar\?pais=co&nivel=2$/);
    await expect(page.getByRole("button", { name: "Quitar filtro: Medianas (Nivel 2)" })).toBeFocused();
  });

  test("date shortcuts fill «Mis fechas de viaje» from today, and a second tap clears them", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    const next30 = page.getByRole("button", { name: "Próximos 30 días" });
    await next30.click();
    await expect(page).toHaveURL(/desde=2026-10-26&hasta=2026-11-24/);
    await expect(page.getByLabel("Desde")).toHaveValue("2026-10-26");
    await expect(page.getByRole("button", { name: "Próximos 30 días" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Próximos 30 días" }).click();
    await expect(page).toHaveURL(/#\/explorar\?pais=co$/);
    await page.getByRole("button", { name: "Este mes" }).click();
    await expect(page).toHaveURL(/desde=2026-10-26&hasta=2026-10-31/);
  });

  test("the world view offers each country's own list in one tap", async ({ page }) => {
    await open(page, "#/explorar");
    const way = page.locator(".explore-hint").getByRole("button", { name: /^Ver las \d+ de Colombia$/ });
    const n = Number((await way.textContent())?.match(/\d+/)?.[0]);
    await way.click();
    await expect(page).toHaveURL(/#\/explorar\?pais=co$/);
    await expect(count(page)).toHaveText(`${n} fiestas`);
  });

  test("RF-04: 2027-02-01 to 2027-02-10 in Colombia returns Barranquilla (deep link)", async ({ page }) => {
    await open(page, "#/explorar?pais=co&desde=2027-02-01&hasta=2027-02-10");
    const results = page.getByTestId("results");
    await expect(results.locator("[data-slug]")).toHaveCount(1);
    await expect(results.locator("[data-slug='carnaval-barranquilla']")).toBeVisible();
    await expect(count(page)).toHaveText("1 fiesta");
  });

  test("RF-04: the travel-date fields write the range into the URL", async ({ page }) => {
    await open(page, "#/explorar?pais=co");
    await page.getByLabel("Desde").fill("2027-02-01");
    await expect(page).toHaveURL(/desde=2027-02-01/);
    await settled(page);
    await page.getByLabel("Hasta").fill("2027-02-10");
    await expect(page).toHaveURL(/#\/explorar\?pais=co&desde=2027-02-01&hasta=2027-02-10$/);
    await expect(page.getByTestId("results").locator("[data-slug='carnaval-barranquilla']")).toBeVisible();
  });

  test("RF-04: a festival known only by its window is labelled as a probable window", async ({ page }) => {
    // Feria de las Flores 2027 has no edition yet: only the rule's window (25 jul to 15 ago).
    await open(page, "#/explorar?pais=co&nivel=2&desde=2027-07-28&hasta=2027-08-10");
    const results = page.getByTestId("results");
    const row = results.locator("[data-slug='feria-de-las-flores']");
    await expect(row).toBeVisible();
    await expect(row.locator(".tag--possible")).toHaveText("Ventana probable, sin fecha oficial");
    // A festival with official dates in the same range carries no such label.
    await open(page, "#/explorar?pais=co&nivel=2&desde=2027-04-28&hasta=2027-04-30");
    const dated = results.locator("[data-slug='festival-vallenato']");
    await expect(dated).toBeVisible();
    await expect(dated.locator(".tag--possible")).toHaveCount(0);
  });

  test("an empty result always offers a way out", async ({ page }) => {
    await open(page, "#/explorar?pais=co&mes=2027-03");
    await expect(page.locator(".empty")).toBeVisible();
    const actions = page.locator(".empty__actions button, .empty__actions a");
    expect(await actions.count()).toBeGreaterThan(0);
    await actions.first().click();
    await settled(page);
    await expect(page.locator(".empty")).toHaveCount(0);
  });

  // ux-F08 «Vacíos que orientan»: every suggestion is counted like the chips and none leads to
  // another empty state.
  test("an empty result offers only ways out that give results, each with its count", async ({ page }) => {
    const hash = "#/explorar?pais=co&mes=2027-03&tipo=tradicion_religiosa";
    await open(page, hash);
    const n = await page.locator(".empty__actions button").count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await open(page, hash);
      const action = page.locator(".empty__actions button").nth(i);
      const label = (await action.textContent()) ?? "";
      const expected = Number(/\((\d+)\)$/.exec(label.trim())?.[1] ?? "0");
      expect(expected, label).toBeGreaterThan(0);
      await action.click();
      await settled(page);
      await expect(page.locator(".empty"), label).toHaveCount(0);
      await expect(count(page), label).toHaveText(`${expected} ${expected === 1 ? "fiesta" : "fiestas"}`);
    }
  });

  // R11: a traveller who misses a festival can suggest it, with the country already filled in.
  test("R11: «Sugerir una fiesta» opens the suggestion form from an empty result and Sobre los datos", async ({ page }) => {
    await open(page, "#/explorar?pais=co&mes=2027-03&tipo=tradicion_religiosa");
    const link = page.locator(".empty").getByRole("link", { name: /Sugerir una fiesta/ });
    await expect(link).toHaveAttribute("target", "_blank");
    const url = new URL((await link.getAttribute("href")) ?? "");
    expect(url.origin + url.pathname).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/new$/);
    expect(url.searchParams.get("template")).toBe("sugerir-fiesta.yml");
    expect(url.searchParams.get("pais")).toBe("CO");
    const yaml = readFileSync(join(ROOT, ".github/ISSUE_TEMPLATE/sugerir-fiesta.yml"), "utf8");
    const ids = new Set([...yaml.matchAll(/^\s+id:\s*([\w-]+)\s*$/gm)].map((m) => m[1]));
    expect([...url.searchParams.keys()].filter((k) => k !== "template" && k !== "title" && !ids.has(k))).toEqual([]);

    await open(page, "#/datos");
    await expect(page.getByRole("link", { name: /Sugerir una fiesta/ })).toHaveAttribute("href", /template=sugerir-fiesta\.yml/);
  });

  test("the bottom navigation opens Explorar on the country Inicio shows", async ({ page }) => {
    await open(page, "#/pais/co");
    await page.getByRole("link", { name: "Explorar" }).click();
    await expect(page).toHaveURL(/#\/explorar\?pais=co$/);
  });
});

// BE-05: a garbled month (year 0000) passes the router's shape check; the screen must still render.
test("a link with mes=0000-01 still renders Explorar", async ({ page }) => {
  await open(page, "#/explorar?pais=co&mes=0000-01");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
