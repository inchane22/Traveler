// Offline support (PRD «Sin conexión»): production only, so the dev server never serves stale code.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const base = import.meta.env.BASE_URL;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      /* No service worker (private mode, unsupported): the site works online as usual. */
    });
  });
}
