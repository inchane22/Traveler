// Offline support (PRD «Sin conexión»): production only, so the dev server never serves stale code.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const base = import.meta.env.BASE_URL;
  // First visit, or a new worker version that cleared the old caches on activate.
  navigator.serviceWorker.addEventListener("controllerchange", () => recacheLoaded(base), { once: true });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      /* No service worker (private mode, unsupported): the site works online as usual. */
    });
  });
}

/**
 * On the first visit (and after an update whose activate dropped the old caches) the page loaded
 * its data and assets before this worker took control, so none of it is in the worker's caches.
 * Once it controls the page, the same files are asked for
 * again (from the HTTP cache when fresh) so the visited country opens offline after one visit.
 */
function recacheLoaded(base: string): void {
  const root = new URL(base, location.href);
  const urls = new Set<string>();
  for (const entry of performance.getEntriesByType("resource")) {
    const url = new URL(entry.name);
    if (url.origin === root.origin && url.pathname.startsWith(root.pathname) && !url.pathname.endsWith("/sw.js")) urls.add(url.href);
  }
  for (const url of urls) {
    fetch(url, { credentials: "same-origin" }).catch(() => {
      /* Offline already or a file that moved: the next online visit caches it. */
    });
  }
}
