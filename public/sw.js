// Traveler service worker (hand-written, no build step).
// - Navigations: network first, cached shell when offline.
// - data/*.json and calendars/*.ics: network first (fresh dates matter), cache as fallback.
// - Other same-origin files (hashed JS/CSS, fonts, icons): stale-while-revalidate.
// Works under any base path: everything is resolved against the registration scope.

const VERSION = "v1";
const SHELL = `traveler-shell-${VERSION}`;
const DATA = `traveler-data-${VERSION}`;
const ASSETS = `traveler-assets-${VERSION}`;
const KEEP = new Set([SHELL, DATA, ASSETS]);
const MAX_ASSETS = 80;

const scope = new URL(self.registration.scope);
const shellUrl = scope.href;

function isSameOrigin(url) {
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

function isData(url) {
  const rel = url.pathname.slice(scope.pathname.length);
  return rel.startsWith("data/") || rel.startsWith("calendars/");
}

function assetUrlsIn(html) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = match[1];
    if (!raw) continue;
    const url = new URL(raw, shellUrl);
    if (isSameOrigin(url) && url.href !== shellUrl && !isData(url)) urls.add(url.href);
  }
  return [...urls];
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((key) => cache.delete(key)));
}

async function precache() {
  const response = await fetch(shellUrl, { cache: "no-cache" });
  if (!response.ok) return;
  const html = await response.clone().text();
  const shell = await caches.open(SHELL);
  await shell.put(shellUrl, response);
  const assets = await caches.open(ASSETS);
  await Promise.all(
    assetUrlsIn(html).map(async (href) => {
      try {
        const res = await fetch(href);
        if (res.ok) await assets.put(href, res);
      } catch {
        // A missing asset is fetched again on first use; the install still succeeds.
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("traveler-") && !KEEP.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName, cacheKey) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(cacheKey ?? request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey ?? request, { ignoreSearch: cacheName === SHELL });
    if (cached) return cached;
    throw error;
  }
}

async function navigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL);
      await cache.put(shellUrl, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(shellUrl, { cacheName: SHELL });
    if (cached) return cached;
    return new Response("Sin conexión / Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        await cache.put(event.request, response.clone());
        await trim(ASSETS, MAX_ASSETS);
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  return fresh ?? Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isSameOrigin(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }
  if (isData(url)) {
    event.respondWith(networkFirst(request, DATA));
    return;
  }
  event.respondWith(staleWhileRevalidate(event));
});
