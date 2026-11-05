// PRD «Prueba de usabilidad», tasks 1, 3 and 4 run on Colombia (the published country):
// 1. Which is the next big festival in Colombia? (answer in under 10 s)
// 3. Add the Carnaval de Barranquilla to your calendar (event with the right dates)
// 4. Is the Barranquilla date confirmed, and where does it come from? (status and source)
import { expect, test } from "@playwright/test";
import { downloadText, nav, open, settled, unfold } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

test("Task 1: the next big festival in Colombia, from a cold start, in under 10 s", async ({ page }) => {
  const started = Date.now();
  await open(page, "#/");
  await page.getByRole("button", { name: /\(cambiar\)/ }).click();
  await page.getByRole("searchbox").fill("colombia");
  await page.getByTestId("country-results").getByRole("link").first().click();
  await settled(page);
  const hero = page.getByTestId("next-festival");
  await expect(hero.getByRole("heading")).toHaveText("Fiestas de la Independencia de Cartagena");
  await expect(hero.locator("[data-countdown]")).toBeInViewport({ ratio: 1 });
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("Task 3: add the Carnaval de Barranquilla to the calendar", async ({ page }) => {
  await open(page, "#/pais/co");
  await nav(page).getByRole("link", { name: "Explorar" }).click();
  await settled(page);
  await page.getByTestId("results").getByRole("link", { name: "Carnaval de Barranquilla" }).click();
  await settled(page);
  await page.getByRole("button", { name: "Agregar al calendario" }).click();
  const { text } = await downloadText(page, page.getByTestId("ics-download"));
  const ics = unfold(text);
  expect(ics).toContain("DTSTART;VALUE=DATE:20270206");
  expect(ics).toContain("DTEND;VALUE=DATE:20270210");
});

test("Task 4: is the Barranquilla date confirmed, and where does it come from?", async ({ page }) => {
  await open(page, "#/pais/co");
  await page.locator(".tl-rows").getByRole("link", { name: /Carnaval de Barranquilla/ }).click();
  await settled(page);
  const when = page.locator(".when");
  await expect(when.locator(".status")).toHaveText("Confirmada");
  await expect(when.locator(".conf")).toHaveText("Fuente: Oficial");
  await expect(when.locator(".when__range")).toHaveAttribute("href", /^https:\/\/(www\.)?carnavaldebarranquilla\.org/);
  await expect(page.locator(".source__link").first()).toContainText("Carnaval de Barranquilla");
});
