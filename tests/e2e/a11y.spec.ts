// WCAG 2.2 AA: axe (wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) on every screen and both sheets,
// in light and dark, with zero violations; plus 44 × 44 px targets and keyboard basics.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { A11Y_TAGS, open, openFilters } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

const SCREENS: [string, string][] = [
  ["Inicio (país)", "#/pais/co"],
  ["Inicio (mundo)", "#/"],
  ["Explorar", "#/explorar?pais=co"],
  // Travel dates that catch both dated rows and window-only rows (.tag--possible).
  ["Explorar con fechas", "#/explorar?pais=co&nivel=2&desde=2027-07-28&hasta=2027-08-10"],
  ["Explorar vacío", "#/explorar?pais=co&mes=2027-03"],
  ["Ficha confirmada", "#/fiesta/carnaval-barranquilla"],
  ["Ficha tentativa", "#/fiesta/independencia-cartagena"],
  ["Ficha sin fecha", "#/fiesta/petronio-alvarez"],
  ["Guardadas", "#/guardadas"],
  ["Ajustes", "#/ajustes"],
  ["Sobre los datos", "#/datos"],
  ["No encontrada", "#/fiesta/no-existe"],
];

async function expectNoViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    for (const [name, hash] of SCREENS) {
      test(name, async ({ page }) => {
        await open(page, hash);
        await expectNoViolations(page);
      });
    }

    test("Guardadas con fiestas", async ({ page }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("traveler.saved", JSON.stringify(["carnaval-barranquilla", "independencia-cartagena", "petronio-alvarez"]));
        } catch {
          /* storage blocked: the list renders empty and the test still scans it */
        }
      });
      await open(page, "#/guardadas");
      await expect(page.getByTestId("saved-list")).toBeVisible();
      await expectNoViolations(page);
    });

    test("selector de ámbito", async ({ page }) => {
      await open(page, "#/pais/co");
      await page.getByRole("button", { name: /\(cambiar\)/ }).click();
      await page.getByRole("searchbox").fill("bra");
      await expect(page.getByTestId("country-results")).toBeVisible();
      await expectNoViolations(page);
    });

    test("hoja de calendario", async ({ page }) => {
      await open(page, "#/fiesta/independencia-cartagena");
      await page.getByRole("button", { name: "Agregar al calendario" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoViolations(page);
    });

    test("hoja de filtros", async ({ page }) => {
      await open(page, "#/explorar?pais=co&tipo=carnaval");
      await openFilters(page);
      await expectNoViolations(page);
    });

    test("hoja de marcas", async ({ page }) => {
      await open(page, "#/pais/co");
      await page.getByRole("button", { name: "Cómo leer las marcas" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoViolations(page);
    });

    test("Sobre los datos con el registro completo", async ({ page }) => {
      await open(page, "#/datos");
      await page.locator(".log-more__toggle").click();
      await expectNoViolations(page);
    });

    test("in English", async ({ page }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("traveler.lang", JSON.stringify("en"));
        } catch {
          /* falls back to Spanish */
        }
      });
      await open(page, "#/fiesta/carnaval-barranquilla");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expectNoViolations(page);
    });
  });
}

test.describe("targets and keyboard", () => {
  // PRD «Pulgar primero»: controls and primary links (date and source links included, ux-F09).
  test("controls and primary links are at least 44 × 44 px", async ({ page }) => {
    const links = [".when__range.link--source", ".event__source", ".source__link", ".link--small", ".section__foot a", ".footer a", ".freshness a", ".log__what a", ".log__sources a", ".fresh__name a"];
    for (const hash of ["#/pais/co", "#/explorar?pais=co", "#/explorar?pais=co&tipo=carnaval&nivel=2", "#/fiesta/carnaval-barranquilla", "#/fiesta/independencia-cartagena", "#/ajustes", "#/datos"]) {
      await open(page, hash);
      const small = await page.evaluate((extra) =>
        [...document.querySelectorAll<HTMLElement>([".btn, .chip, .pill, .navlink, .save, .icon-btn, .option, .switch, .segmented__opt, .scope-btn, .radio, .wordmark, .log-more__toggle", ...extra].join(", "))]
          .filter((el) => el.offsetParent !== null)
          .map((el) => ({ el: el.className, text: el.textContent?.trim().slice(0, 30), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }))
          .filter((r) => r.w < 43.5 || r.h < 43.5),
        links,
      );
      expect(small, hash).toEqual([]);
    }
  });

  test("the skip link moves focus to the main content", async ({ page }) => {
    await open(page, "#/pais/co");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Saltar al contenido" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await expect(page).toHaveURL(/#\/pais\/co$/);
  });

  test("a new screen moves focus to its title", async ({ page }) => {
    await open(page, "#/pais/co");
    await page.getByTestId("next-festival").getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  });

  test("no horizontal scroll at phone width", async ({ page }) => {
    // #/datos prints raw changelog values (URLs, JSON) and the fichas print notes and quotes.
    const hashes = ["#/pais/co", "#/explorar?pais=co", "#/fiesta/carnaval-barranquilla", "#/fiesta/independencia-cartagena", "#/fiesta/petronio-alvarez", "#/guardadas", "#/ajustes", "#/datos"];
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const hash of hashes) {
        await open(page, hash);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${width} px ${hash}`).toBeLessThanOrEqual(0);
      }
    }
  });

  // Linux CI renders the same fonts about 1% wider than macOS; a nowrap tag that exactly fit its row
  // on macOS overflowed by 1 px there. Extra letter-spacing stands in for that metric drift.
  test("no horizontal scroll at 320 px when text renders wider than on the dev machine", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    for (const hash of ["#/pais/co", "#/explorar?pais=co", "#/fiesta/petronio-alvarez", "#/guardadas", "#/datos"]) {
      await open(page, hash);
      // The CSP refuses injected <style>; CSSOM writes are allowed.
      const overflow = await page.evaluate(() => {
        for (const el of [document.body, ...document.body.querySelectorAll<HTMLElement>("*")]) el.style.setProperty("letter-spacing", "0.04em", "important");
        return document.documentElement.scrollWidth - document.documentElement.clientWidth;
      });
      expect(overflow, `320 px ${hash} with wider text`).toBeLessThanOrEqual(0);
    }
  });
});
