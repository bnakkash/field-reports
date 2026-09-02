/* ══════════════════════════════════════════════════════════════
   Field Report — service worker
   Place at the ROOT of your published output (e.g. public/sw.js in
   Vite, which copies to dist/sw.js). Its scope is derived from where
   it is served, so this file works unchanged on a GitHub Pages
   project site (/repo-name/) or a user site (/).

   Strategy, and why:
   - Navigations   → network-first with a 3s timeout, cache fallback.
     A field phone on one bar must not hang on a dead request.
   - Static assets → stale-while-revalidate. Vite hashes filenames,
     so a cached asset is never stale in a harmful way, and this
     needs no build-time manifest to keep in sync.
   - Google Fonts  → cache-first, long-lived. Without this the app
     silently drops to system fonts offline.
   - Supabase / API → never touched. Non-GET and cross-origin API
     calls pass straight through; caching a POST would be wrong and
     caching a structuring response would be worse.
   ══════════════════════════════════════════════════════════════ */

const VERSION = 'v4';
const SHELL = `fr-shell-${VERSION}`;
const ASSETS = `fr-assets-${VERSION}`;
const FONTS = `fr-fonts-${VERSION}`;
const KEEP = [SHELL, ASSETS, FONTS];

// Scope-relative, so no hardcoded /repo-name/ to get wrong.
const BASE = new URL('./', self.registration.scope).pathname;
const INDEX = BASE + 'index.html';

const NAV_TIMEOUT_MS = 3000;

// ─── install ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Only the shell. Everything else is cached on first use, which
      // keeps this correct across builds without a generated file list.
      try {
        await cache.add(new Request(INDEX, { cache: 'reload' }));
      } catch {
        // Offline at install time — the fetch handler will fill it later.
      }
    })()
  );
});

// ─── activate ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('fr-') && !KEEP.includes(n)).map((n) => caches.delete(n))
      );
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch { /* noop */ }
      }
      await self.clients.claim();
    })()
  );
});

// ─── message: let the page trigger an update ───
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ─── helpers ───
function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function networkFirstNavigation(event) {
  const cache = await caches.open(SHELL);
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || (await Promise.race([fetch(event.request), timeout(NAV_TIMEOUT_MS)]));
    if (res && res.ok) cache.put(INDEX, res.clone());
    return res;
  } catch {
    // SPA on GitHub Pages: any route falls back to the cached shell.
    const cached = (await cache.match(INDEX)) || (await caches.match(event.request));
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Field Report — offline</title>' +
        '<body style="background:#0a0a0a;color:#e7e5e4;font:14px ui-monospace,monospace;padding:32px">' +
        '<p style="color:#fbbf24;letter-spacing:.2em">FIELD·REPORT</p>' +
        '<p>Offline, and the app shell was never cached on this device.</p>' +
        '<p style="color:#78716c">Open this page once with a connection, then it will launch offline.</p>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

// ─── fetch ───
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never intercept anything that isn't a plain GET. This is what keeps
  // the Supabase structuring POST — and its CORS preflight — untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts: stylesheet from googleapis, files from gstatic.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONTS));
    return;
  }

  // Anything else cross-origin (Supabase included) goes to the network untouched.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  const dest = request.destination;
  if (['script', 'style', 'font', 'image', 'worker', 'manifest'].includes(dest)) {
    event.respondWith(staleWhileRevalidate(request, ASSETS));
  }
});
