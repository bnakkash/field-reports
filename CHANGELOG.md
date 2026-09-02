# Changelog

## v0.4

### The endpoint is no longer open to anyone with the link

With no shared secret, anyone who opened the published app could spend the
project's Anthropic credit. The origin allowlist never addressed this — it
allows *this site*, and anyone can load this site.

Setting `FR_SHARED_SECRET` on the function now locks it, and the client asks
for the passphrase **lazily, on a 401**. That laziness is the design: with no
secret set the app never prompts, so the same build works against a secured or
unsecured function with nothing to keep in sync, and rotating the secret makes
every device re-prompt on its next attempt.

A rejected passphrase is discarded rather than cached — otherwise a stale value
would fail every future request with no way to correct it from the UI.

**The secret is no longer compiled into the bundle.** It was previously read
from `VITE_FR_KEY`, which put it in the public JavaScript for anyone to read:
a lock with the key taped to it. It now lives only in each device's own
storage, and a test asserts the shipped bundle contains nothing key-shaped.

This stops anyone who finds the URL. It is not authentication, and it does not
replace a spend limit — see README for the honest boundary.

### Silent mode

The app has never played a sound — nothing in it touches an audio output, and
the `AudioContext` drives the level meter without being connected to one. The
chimes are iOS's: Safari plays the system dictation tone every time
`SpeechRecognition` starts or stops, and it ends recognition sessions on its
own throughout a long dictation, so each restart chimes again.

A web page cannot suppress a system sound, so the only available lever is not
to run the recognizer. Silent mode does exactly that: no recognizer is ever
constructed, audio still records, and the transcript becomes a text field you
type into — or dictate into with the keyboard's own microphone, which is quiet.
Structuring, review and save are unchanged. The preference persists per device.

A test asserts zero `SpeechRecognition` constructions in silent mode, since
"we didn't start it" is the entire feature.

### Edge-swipe back

Swiping right from the left edge goes back — detail to log, log to home, review
to transcript. It mirrors the iOS gesture, which is what a thumb reaches for.

Deliberately edge-anchored rather than a free-form swipe: the gesture must
begin within 28px of the left edge, travel at least 64px, stay within 48px
vertically, and complete inside 700ms. Anything looser fires while selecting
transcript text or dragging the audio scrubber. It is also inert while
recording — losing a dictation to a stray thumb is far worse than having no
gesture. The negative cases are tested alongside the positive one.

Also fixed: the record button read TAP TO RESUME whenever the transcript had
text, which in silent mode meant offering to resume a recording that never
started. It now keys off whether audio actually exists.

### CALL NOTES template

A fourth template, for a recorded phone call rather than a walkdown — the shape
Plaud and similar recorders produce. Fields are who / topic / action / owner,
with owner an enum of ME · THEM · BOTH · NONE, because the thing worth keeping
out of a call is who owes what. Anything you owe renders amber so a glance down
the list finds your commitments.

The prompt is explicit that a call is mostly conversation and only partly a
record: greetings, scheduling chatter and small talk are dropped rather than
turned into rows. It is also told to leave "who" blank when no name was said —
a wrong attribution in a record of who promised what is worse than a blank
field — and to keep a garbled price or date as the raw spoken phrase rather
than committing to a number.

Verified against a real call transcript: five rows, small talk discarded, the
callback attributed to THEM and the datasheet to ME, and a price the caller
half-heard preserved as "possibly $32.40 a set, but line broke up so unclear"
instead of being asserted.

### The plant's own vocabulary is in the prompt

The misreadings that matter here were never a general speech problem. "855
vacuum issues" is A55; "TE105 on 810" is A10. They fail because a general model
has never heard of these units — not because it needs training. The site has a
finite, documented list of them, and DataParc's ctc_v_processtags is
authoritative for every tag.

So the structuring prompt now names all 30 process units and the standard
instrument prefixes, with the recognition patterns speech-to-text actually
produces. Appended once at the call site rather than pasted into each template,
so there is one place to edit when the plant gains a unit. Deliberately not a
client input — a vocabulary the browser could edit is one an attacker could
edit.

The hard part was restraint, not recall. A first version fixed A55 and A10 but
started fabricating: "reels at 300 a" became M300A, and "TT 51 a 50" produced a
phantom A50. The rules are now bounded — the swallowed-letter pattern applies
only when the remaining digits are exactly an A-series number, the M-series is
declared always audible, and digits belonging to an instrument tag are declared
never also a unit. A fabricated location in a maintenance record is worse than
a number left as it was heard.

`npm run check:vocab` pins this against the real dictation. It calls the live
endpoint, so it costs about five cents and stays outside `npm test`, which must
remain free and offline. Its checks are split: required ones the vocabulary
must satisfy every run, and advisory ones that depend on the model's judgement
about whether a garbled fragment is worth keeping at all — reported, never
fatal, because a model call is not a pure function.

Also corrects the function's fallback model, still pinned to claude-sonnet-4-5
in code while the deployed secret said otherwise — harmless until the day
someone clears the secret.

### The phone's own doubt is now visible

A device diagnostic (`public/diag.html`) settled two things this app had been
guessing about. On iOS 18.7, WebKit **does** report a confidence score — the
concern that it always returns 0 was unfounded — and it offers up to five ranked
readings per phrase. Both were being discarded: the code read `res[0].transcript`
and nothing else, and never raised `maxAlternatives` above its default of 1.

On a real walkdown dictation the split was stark. The one unusable phrase scored
0.38 while every good one scored 0.94 or better, and where a unit tag came back
wrong — "855 vacuum issues" for what should read A55 — the correct reading was
sitting in the alternatives the app had thrown away.

So it keeps them. Phrases below 0.9 are underlined in the transcript, and tapping
any phrase shows what else the phone heard, with the score. Choosing a different
reading rewrites the transcript, which is now derived from the recognised phrases
rather than accumulated as loose text — so a repair reaches the words the model
actually sees. Repaired phrases stop counting toward the banner, which tracks what
is left rather than what once was.

This is a two-tap correction for the failure that matters most in this app: a
wrong digit in an instrument tag, on a phone, at the equipment. Hand-editing was
always possible; knowing *where* to look was not.

Also: the record button had no accessible name — an icon in an unlabelled
button, on the app's primary control.

### CALL NOTES admits when it cannot tell who owes something

Tested against a real recorded call, the first version confidently assigned the
other party's commitments to ME and missed one that genuinely was the
note-taker's. The cause is structural rather than a prompt weakness: a
single-channel recording has no speaker labels, both sides say "I", and nothing
in the transcript reliably identifies which one is holding the phone. Asked to
choose, the model guesses at roughly a coin flip.

So it is no longer asked to choose. `owner` gains UNCLEAR, which is now the
default, and the prompt is explicit that ME or THEM may only be used when the
transcript itself settles it. Re-run on the same call, every ownership claim it
could not support came back UNCLEAR instead of wrong.

Flagged rows reuse the machinery the loop template already uses for
unverifiable tags — amber border, a badge, and a banner — with the label and
explanation now coming from the template, so a call says WHO OWES THIS? rather
than CHECK TAG. This is the same principle as never guessing a tag digit: an
admitted unknown that gets reviewed beats a confident answer that is wrong half
the time, especially in a record of who promised what.

### Dead air no longer retires transcription

Recognition sessions end on their own after a few seconds of silence — that is
normal, not a failure. Both kinds of ending spent the same 40-restart budget,
and only actual speech reset it, so standing quiet between units could exhaust
it and stop transcription for the rest of the walkdown. The banner said so, but
a phone in a pocket does not show banners.

Silence-ended and error-ended sessions are now budgeted separately: silence
restarts immediately and does not count against the failure budget, real errors
get eight attempts with a backoff, and an unbroken-silence backstop of ~40
minutes exists only to stop a pathological loop.

Pending interim text is also promoted to the transcript on *every* session end
rather than only the last, so a phrase caught mid-utterance when Safari drops
the session is no longer lost. When the engine already finalised it the buffer
is empty and nothing is written twice.

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
