# Field Report

Voice-to-structured field reports for plant walkdowns. Dictate at the
equipment, get a structured punch list / loop check / field note, review and
correct it, save it to a local log.

**v0.3** — see `CHANGELOG.md` for what changed, `DEFECTS.md` for the
remaining setup steps.

---

## Getting it running

```bash
npm install
cp .env.example .env
npm run dev
```

```bash
npm test          # headless Chromium at 414×896; starts its own dev server
```

Open the localhost URL in Chrome. `localhost` is a secure context, so the
microphone and service worker both work. **Do not test over your LAN IP** —
`http://192.168.x.x` is not a secure context and both will silently refuse.
Test on the phone via the deployed Pages URL instead.

## Deploying

1. Push to `main`.
2. Repo **Settings → Pages → Source = GitHub Actions**.
3. Repo **Settings → Secrets and variables → Actions → Variables**, add:

   ```
   VITE_STRUCTURE_ENDPOINT = https://itxcaamyiilvotfzctit.supabase.co/functions/v1/structure-report
   ```

   A *variable*, not a secret — it is a public URL the build must read.

The base path is derived automatically from `GITHUB_REPOSITORY` in
`vite.config.js`, so renaming the repo will not break the deploy. That was the
most common failure mode; it is now impossible to get wrong by hand.

`.github/workflows/deploy-pages.yml` is the only deploy workflow. An earlier
`deploy.yml` built the site by unzipping a committed `app.zip` snapshot, and
that is what every deploy before v0.3 published. It was deleted in the same
commit that added this one, deliberately: both fire on `push: main` and share
`concurrency: group: pages` with `cancel-in-progress: true`, so leaving both in
place would have had them race and cancel each other. The zip is gone too —
the repo is the source.

## Onto the phone

Open the Pages URL in Safari → Share → **Add to Home Screen**. Launch from the
icon, not the tab.

This is not cosmetic. Under Safari 17+ a home screen web app gets the same
origin quota as the browser, and `navigator.storage.persist()` — which the app
calls on boot — is granted on heuristics that include whether the site is
running as a home screen web app. In a tab, your reports and audio are ordinary
evictable storage.

---

## The Edge Function

Runs in its own Supabase project, `itxcaamyiilvotfzctit` — deliberately not
the one hosting the PM-Scheduler SaaS, since Edge Function secrets are
per-project and an Anthropic key should not share a blast radius with anything
else. Source of truth is `supabase/functions/structure-report/index.ts`.

It is deployed. Redeploy after an edit with:

```bash
supabase functions deploy structure-report --project-ref itxcaamyiilvotfzctit
```

`supabase/config.toml` pins `verify_jwt = false` for it, so no flag is needed —
Edge Functions demand a Supabase JWT by default, and this client sends no
`Authorization` header, so a redeploy with verification on 401s everything.

**It still has no API key, so GENERATE REPORT returns 500 until you set one:**

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...                 --project-ref itxcaamyiilvotfzctit
supabase secrets set ALLOWED_ORIGINS=https://bnakkash.github.io   --project-ref itxcaamyiilvotfzctit
supabase secrets set FR_SHARED_SECRET=$(openssl rand -hex 16)     --project-ref itxcaamyiilvotfzctit
```

Recording and SAVE RAW work without it — test those first.

If you set `FR_SHARED_SECRET`, put the same value in `.env` as `VITE_FR_KEY`
and the client will send it. Note it ships in the public bundle: a speed bump
against casual abuse, not a secret. The thing the proxy actually guarantees is
that your Anthropic key is never in the browser.

---

## Architecture

```
Safari / home screen web app
  ├─ Web Speech API ──────────► Apple's servers        (needs network)
  ├─ MediaRecorder ───────────► Opus blob → IndexedDB  (works offline)
  ├─ IndexedDB ───────────────► reports + audio        (works offline)
  └─ fetch ───────────────────► Supabase Edge Function (needs network)
                                        └─► Anthropic API  [key lives here]
```

**Capture works offline. Structuring does not.** When speech recognition fails
for lack of network, audio capture continues and the app says so; SAVE RAW
stores the walkdown to structure later.

### Known platform ceiling

iOS suspends a web app when the screen locks or you switch apps — recording
stops. The wake lock prevents the *automatic* dim-and-lock, which is the usual
way you lose a dictation, but nothing prevents a manual lock or an app switch.
There is no background audio for web apps on iOS.

Practically: this is the right tool for a deliberate five-minute dictation at a
piece of equipment. It will never do passive all-day capture.

---

## Verified

Built and rendered in Chromium at 414×896 before shipping:

| Check | Result |
|---|---|
| Production build | clean, 190 KB → 60 KB gzipped |
| Both screens render | pass |
| Reports round-trip through IndexedDB | pass |
| Audio Blob stored and retrieved intact | pass, 64 KB test blob |
| Opus / MediaRecorder / WakeLock / SpeechRecognition present | pass |
| Console errors | none except Google Fonts, blocked in the test sandbox |

Re-verified for v0.3 — 31 automated checks in headless Chromium at 414×896,
production build clean (193 KB → 60 KB gzipped). The whole structure-later
path was driven end to end: a raw capture opens with STRUCTURE IT NOW, carries
its transcript into the record screen, structures (against a canned model
reply), passes review, and on save **replaces** the original log entry — same
id, same `createdAt`, `raw` cleared, no duplicate row. Enum coercion,
suspect-tag flagging, raw COPY output, and the translated proxy error were
checked in the same pass.

Still device-only, as before: anything that needs a real microphone — speech
recognition in an iOS standalone app, the interim-transcript flush on stop,
and the wake lock — cannot be exercised headless.

Not verified — needs a real device:

- Speech recognition inside an iOS **standalone** home screen app. There is a
  long history of this working in Safari and failing when installed. Dictate
  once in each; if the transcript appears in one and not the other, that is the
  bug, not your microphone.
- Whether WebKit actually grants persistent storage after install.

## Layout

```
tests/                 Playwright suite for the structure-later path
src/FieldReport.jsx    the app
src/registerSW.js      service worker registration + update prompt
src/main.jsx           entry
public/sw.js           offline shell, asset and font caching
public/manifest.webmanifest
.github/workflows/deploy-pages.yml
supabase/functions/structure-report/index.ts   (deployed; here for reference)
```
