# Field Report v0.2 — setup

Everything below is done. What's left is four steps you have to run yourself,
because they involve your API key and your repo.

---

> **Status check, 2026-09-01.** The function is live — a GET returns
> `405 method_not_allowed` — but a POST still returns
> `500 {"error":"server_misconfigured"}`, which means `ANTHROPIC_API_KEY` has
> never been set. Step 2 below is still outstanding, and GENERATE REPORT
> cannot work until it is done. Recording and SAVE RAW work today.

## 1. Rotate your Anthropic key — do this first

If the key was ever committed to the repo, it is in git history and in every
clone. Removing it from the current file changes nothing. Rotate it at
console.anthropic.com, then continue.

---

## 2. The Edge Function is already deployed

Deployed to your Supabase project `bnakkash's Project PM-Scheduler-SaaS`
(`vvilcwkizpprjrfvthgk`) — it was your only project. It sits alongside `scalar`
and shares nothing with it. Move it to its own project later if you'd rather
keep the SaaS clean.

**Endpoint**

```
https://vvilcwkizpprjrfvthgk.supabase.co/functions/v1/structure-report
```

Verified live: a GET returns `405 method_not_allowed` from the handler.
It will return `500 server_misconfigured` until you set the key below.

**Set the secrets** (never paste the key into the app or the repo):

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...            --project-ref vvilcwkizpprjrfvthgk
supabase secrets set ALLOWED_ORIGINS=https://YOURNAME.github.io --project-ref vvilcwkizpprjrfvthgk
supabase secrets set FR_SHARED_SECRET=$(openssl rand -hex 16)  --project-ref vvilcwkizpprjrfvthgk
```

`ALLOWED_ORIGINS` and `FR_SHARED_SECRET` are optional but recommended. If you
set the shared secret, send it from the client as the `x-fr-key` header.

**What the proxy does and does not buy you.** It guarantees your Anthropic key
is never in the browser and can only ever be used through this one endpoint's
narrow shape — that was the actual P0. It does not make the endpoint private:
an origin allowlist and a secret that ships in a public bundle stop casual
abuse, not a determined caller. Watch spend, and rotate the shared secret if
you see traffic you didn't cause.

Function protections already in place: origin allowlist, optional shared
secret, 20 req/min per IP burst limit, 40k character transcript cap, 200 KB
body cap, upstream errors translated instead of passed through.

---

## 3. Point the app at it

`.env` (or GitHub Actions repository variable):

```
VITE_STRUCTURE_ENDPOINT=https://vvilcwkizpprjrfvthgk.supabase.co/functions/v1/structure-report
```

---

## 4. Wire up the PWA files

Copy into `public/` so they land at the root of `dist/`:

```
public/sw.js
public/manifest.webmanifest
public/icon-192.png
public/icon-512.png
public/icon-maskable-512.png
public/apple-touch-icon.png
```

Put `registerSW.js` in `src/` and import it from your entry point:

```js
import { registerSW } from './registerSW';

registerSW({
  onUpdate: (apply) => {
    // Do NOT auto-reload — that discards an in-progress dictation.
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
```

Add to `index.html` `<head>`:

```html
<link rel="manifest" href="./manifest.webmanifest">
<link rel="apple-touch-icon" href="./apple-touch-icon.png">
<meta name="theme-color" content="#0a0a0a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

**Vite base path.** A GitHub Pages *project* site serves from `/repo-name/`, so
`vite.config.js` needs `base: '/repo-name/'`. Every path above is relative, and
the service worker derives its scope from where it is served, so nothing else
needs changing.

---

## Service worker design

| Request | Strategy | Why |
|---|---|---|
| Navigation | Network-first, 3 s timeout → cached shell | A phone on one bar must not hang on a dead request |
| JS / CSS / fonts / images | Stale-while-revalidate | Vite hashes filenames, so no build-time manifest to keep in sync |
| Google Fonts | Cache-first | Otherwise the app silently drops to system fonts offline |
| Supabase structuring call | **Untouched** | Non-GET and cross-origin requests are never intercepted — caching a POST would be wrong |

First offline launch requires one prior online visit. That's inherent: the
shell has to be cached before it can be served.

If you later want precaching with a generated manifest, `vite-plugin-pwa`
(Workbox) does it properly. This hand-written worker is dependency-free and
survives a build-tool change, which seemed the better trade for one app you
maintain alone.

---

## Verify before you trust it

1. Load the app online once. DevTools → Application → Service Workers shows it activated.
2. Airplane mode, force-quit, relaunch from the home screen. It should open to the template picker.
3. Record something offline. The amber **SPEECH SERVICE UNAVAILABLE** banner should appear and audio should keep recording.
4. Tap **SAVE RAW**. It should land in the log with `RAW` and `AUDIO` chips.
5. Back online, open that report — the audio player should be there.
6. Structure a new dictation end to end and confirm a report saves.

Step 6 is the one that matters most. Saving was completely broken in v0.1, and
it failed silently, so a passing save is the signal that the worst defect is
actually gone.
