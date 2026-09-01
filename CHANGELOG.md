# Changelog

## v0.3

### The repo now builds the site

Only three files were tracked in git — `README.md`, `app.zip`, and an old
`.github/workflows/deploy.yml`. Everything that matters (`src/`, `public/`,
`supabase/`, `index.html`, `vite.config.js`, `package.json`) was untracked, so
a clone got a zip and a workflow that unzipped it.

Only `deploy.yml` was ever committed, so every deploy up to now built from
`app.zip` — both runs in the Actions history are that workflow. The newer
`deploy-pages.yml` sat untracked on disk, which is the trap: committing the
source without removing `deploy.yml` would have left two workflows on
`push: main` sharing `concurrency: group: pages` with `cancel-in-progress:
true`, racing to cancel each other with a nondeterministic winner. Hence one
commit rather than two.

`deploy.yml` and `app.zip` are removed. `deploy-pages.yml` — which builds from
the repo and reads `VITE_STRUCTURE_ENDPOINT` from an Actions variable — is the
only deploy path. The zip's contents were diffed against the working tree
first: it was the same v0.2 source minus the safe-area-inset layout fixes, so
nothing existed only inside it.

### "STRUCTURE LATER" now exists

`SAVE RAW — STRUCTURE LATER` promised something the app could not do. A raw
capture was a dead end: no screen anywhere could take a saved transcript and
run it through the proxy.

A saved report now opens with **STRUCTURE IT NOW**, and a structured one has
**↻ RE-STRUCTURE FROM THIS TRANSCRIPT** under the transcript. Both reload the
transcript into the record screen — editable, so a misheard tag can be fixed
before the model ever sees it — and reuse the existing structure → review →
save flow.

Saving **replaces the original entry under the same id** instead of logging a
second copy of one walkdown. That also keeps the report's `audio:<id>` blob
attached, which a new-id save would have orphaned.

### Fixes

- **Navigating away no longer leaves the recognizer running.** `SpeechRecognition`
  does not use the `getUserMedia` stream, so `releaseMic()` never stopped it.
  Tapping the logo or LOG mid-dictation left `recording` true and final results
  appending to a transcript that was no longer on screen. Both now stop the
  recording — which also checkpoints the draft — before switching view.
- **Stopping mid-sentence no longer drops the last words.** Pending interim text
  was discarded on stop. It is now flushed into the transcript on the terminal
  `onend`, and only if no final result arrived for it, so Chrome (which
  normally promotes it first) does not get it twice.
- **The 90-minute audio cap no longer leaks a timer per take.** Each recording
  installed a `setTimeout` that was never cleared; five takes left five live
  90-minute timers and their closures for the rest of the session.
- **Raw captures export their transcript.** COPY and CSV built a table from
  `items`, which is empty for a raw capture — so both produced a header and no
  data, indistinguishable from a successful export. They now emit the
  transcript, which for a raw capture *is* the record.
- **CSV values that open with `=` `+` `-` `@` are quote-prefixed.** Excel and
  Sheets execute those as formulas, and "-40 degrees at the exchanger" is a
  plausible dictation.
- **Proxy errors are translated.** A field UI showing
  `Server 500: {"error":"server_misconfigured"}` tells nobody anything; each
  known code now maps to the action that fixes it.
- **The app no longer reloads itself on every first visit.** `sw.js` calls
  `clients.claim()` on activate, which changes the controller from none to
  ours; `registerSW.js` treated any controller change as "an update was
  applied" and reloaded. A first visit therefore always cost an extra round
  trip — worst on the one-bar connection this app is built for. Only a change
  that follows an existing controller reloads now. (Found by the new test
  suite, which could not seed a fixture before the page navigated out from
  under it.)
- **The audio player no longer leaks an object URL** when a report is closed
  before its blob finishes loading.
- **The `+ AUDIO` label is state, not a ref.** It was read from
  `pendingAudioRef` during render, so it lagged a take behind.
- **A re-structured report can no longer inherit an abandoned take's audio.**
  Leaving the record screen for the log stops the recording but does not reset,
  so a pending blob could still be in hand when a saved report was reopened and
  structured — it would have been filed under *that* report's id, overwriting
  its own audio. `restructure()` now drops the pending blob; the report's own
  recording is preserved through the existing entry.
- **`persistReport` had a stale-closure hazard** — it called `reset` without
  declaring it. `reset` is now defined above it and declared as a dependency.

### Tests

`npm test` runs `tests/structure-later.spec.js` in headless Chromium at
414×896 — the phone viewport the UI is designed against. It drives the whole
v0.3 path: raw capture → COPY → STRUCTURE IT NOW → the translated proxy error
→ LEAVE AS RAW → structure → review → save, asserting against IndexedDB that
the log holds one entry with its original id and `createdAt` rather than two.

The structuring endpoint is mocked in both directions, so the suite needs no
network and no API key. That is deliberate: the real endpoint answers 500 today,
and a test that spends someone's Anthropic budget is a test people stop running.

It cannot cover anything needing a real microphone — speech recognition, the
interim flush on stop, the wake lock. Those stay device checks.

### Removed

- The three prompt strings in the client `TEMPLATES` table. Nothing read them;
  the prompts live in `supabase/functions/structure-report/index.ts`, and the
  two copies had already drifted.
- The ~60-line commented-out copy of the edge function at the bottom of
  `FieldReport.jsx`, which had drifted from the deployed version too.

### Known, unchanged

- **Resuming a dictation replaces the audio.** `TAP TO RESUME` accumulates the
  transcript but starts a fresh `MediaRecorder`, so only the last take's audio
  is kept. Concatenating independent WebM streams does not reliably play back,
  so this needs a real fix (one recorder across takes) rather than a quick one.
- **The Edge Function still has no `ANTHROPIC_API_KEY`.** GENERATE REPORT
  returns 500 until `DEFECTS.md` step 2 is run.
- **iOS suspends a web app when the screen locks or you switch apps.** No
  background audio for web apps exists; the wake lock only prevents the
  automatic dim-and-lock.
