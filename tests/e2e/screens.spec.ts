// Reference screenshots of every screen at 390 × 844, light and dark, for design review.
// Written to test-results/screens/ (not compared: the review is by eye, the checks live elsewhere).
import { expect, test } from "@playwright/test";
import { open } from "./helpers.ts";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

const SCREENS: [string, string][] = [
  ["inicio", "#/pais/co"],
  ["explorar", "#/explorar?pais=co"],
  ["explorar-fechas", "#/explorar?pais=co&desde=2027-02-01&hasta=2027-02-10"],
  ["ficha", "#/fiesta/carnaval-barranquilla"],
  ["ficha-tentativa", "#/fiesta/independencia-cartagena"],
  ["guardadas", "#/guardadas"],
  ["ajustes", "#/ajustes"],
  ["datos", "#/datos"],
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test("every screen", async ({ page }, info) => {
      test.skip(info.project.name !== "mobile", "phone screenshots only");
      await page.addInitScript(() => {
        try {
          localStorage.setItem("traveler.saved", JSON.stringify(["carnaval-barranquilla", "feria-de-cali"]));
        } catch {
          /* empty Guardadas then */
        }
      });
      for (const [name, hash] of SCREENS) {
        await open(page, hash);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `test-results/screens/${name}-${scheme}.png` });
        await page.screenshot({ path: `test-results/screens/${name}-${scheme}-full.png`, fullPage: true });
      }
      await open(page, "#/fiesta/carnaval-barranquilla");
      await page.getByRole("button", { name: "Agregar al calendario" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
      await page.screenshot({ path: `test-results/screens/hoja-calendario-${scheme}.png` });
      await page.keyboard.press("Escape");
      await open(page, "#/pais/co");
      await page.getByRole("button", { name: /\(cambiar\)/ }).click();
      await page.getByRole("searchbox").fill("bra");
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
      await page.screenshot({ path: `test-results/screens/hoja-ambito-${scheme}.png` });
    });
  });
}
