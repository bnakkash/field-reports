/* ══════════════════════════════════════════════════════════════
   Service worker registration + update prompt.
   Import once from your entry point:  import './registerSW';

   Registers relative to the page, so it works on a GitHub Pages
   project site without hardcoding the repo path.
   ══════════════════════════════════════════════════════════════ */

export function registerSW({ onUpdate } = {}) {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  window.addEventListener('load', async () => {
    try {
      // import.meta.env.BASE_URL is Vite's build-time base ('/repo-name/').
      // Falls back to the document base for non-Vite builds.
      const base =
        (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
      const reg = await navigator.serviceWorker.register(base + 'sw.js', { scope: base });

      // A waiting worker means a new build is cached and ready.
      if (reg.waiting) onUpdate?.(() => activate(reg));

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            onUpdate?.(() => activate(reg));
          }
        });
      });

      // Check for a new build when the app is brought back to the
      // foreground — a field phone can sit in a pocket for hours.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch (e) {
      console.warn('SW registration failed', e);
    }
  });

  // A controller change means an update was applied — EXCEPT on the very first
  // visit, where sw.js's clients.claim() takes an uncontrolled page and changes
  // the controller from none to ours. Reloading there costs a first-visit round
  // trip, and on a phone on one bar that is the worst moment to spend one.
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function activate(reg) {
  reg.waiting?.postMessage('SKIP_WAITING');
}

/* ──────────────────────────────────────────────────────────────
   Minimal usage in main.jsx:

     import { registerSW } from './registerSW';

     registerSW({
       onUpdate: (apply) => {
         // Do NOT auto-reload — that would discard an in-progress
         // dictation. Surface it and let the user choose.
         const bar = document.createElement('button');
         bar.textContent = 'NEW VERSION READY — TAP TO UPDATE';
         bar.style.cssText =
           'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:14px;' +
           'background:#fbbf24;color:#0a0a0a;border:0;font:600 11px ui-monospace,monospace;' +
           'letter-spacing:.15em';
         bar.onclick = apply;
         document.body.appendChild(bar);
       },
     });
   ────────────────────────────────────────────────────────────── */
