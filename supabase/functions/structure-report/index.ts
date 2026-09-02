import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * structure-report
 *
 * Anthropic proxy for the Field Report PWA.
 *
 * Why this exists: a static PWA cannot hold an API key. Anything in the
 * bundle is readable by anyone who opens devtools. This function keeps the
 * Anthropic key server-side and gives the client a narrow, typed endpoint
 * that only knows how to do one thing.
 *
 * Required secret:
 *   ANTHROPIC_API_KEY   - your Anthropic key
 *
 * Optional secrets:
 *   ALLOWED_ORIGINS     - comma-separated origin allowlist.
 *                         e.g. "https://you.github.io,http://localhost:5173"
 *                         Unset = any origin (fine while developing, tighten later).
 *   FR_SHARED_SECRET    - if set, requests must send it as the x-fr-key header.
 *   ANTHROPIC_MODEL     - override the model id.
 *
 * Honest note on the threat model: an origin allowlist and a shared secret
 * that ships in a public bundle stop casual abuse, not a determined caller.
 * What they DO guarantee is that your Anthropic key is never exposed and can
 * never be used outside this endpoint's narrow shape. Watch spend, and rotate
 * FR_SHARED_SECRET if you see traffic you didn't cause.
 */

// ─────────────────────────────────────────────────────────────
// Prompts live here, not in the client — a client-side prompt is
// editable by anyone, which turns your key into a general-purpose
// LLM endpoint for whoever finds it.
// ─────────────────────────────────────────────────────────────
const TEMPLATES: Record<string, string> = {
  punch: `You are structuring a field punch list from a field engineer's spoken notes.
Extract discrete punch items. Merge fragments about the same item.

Return JSON ONLY in this exact shape, no prose, no code fences:
{ "items": [ { "item": "short description", "location": "unit/equipment", "action": "what needs to happen", "priority": "HIGH|MED|LOW" } ] }

Priority rules: HIGH = safety, hot work, blocking commissioning; LOW = cosmetic/paperwork; MED = default.
If a field isn't stated, leave it as empty string. Keep it terse — no filler words.
The dictation is raw speech-to-text and WILL contain misrecognitions. Do not invent
detail to paper over a garbled phrase — leave the field empty instead.`,

  loop: `You are structuring loop check notes from a field E&I engineer.
Extract one row per instrument tag mentioned.

Tag normalization: uppercase, preserve hyphens (e.g. "ft one oh one" -> "FT-101", "level transmitter two hundred" -> "LT-200").
Type: infer from tag prefix (FT=FLOW, LT=LEVEL, TT=TEMP, PT=PRESS, etc.) or from words used.
Status: PASS | FAIL | PEND | BLOCK. Infer from context ("checks out" = PASS, "no comms" = FAIL, "waiting on" = BLOCK, unclear = PEND).

Return JSON ONLY:
{ "items": [ { "tag": "FT-101", "type": "FLOW", "status": "PASS", "notes": "short issue/observation" } ] }

The dictation is raw speech-to-text. Digits are the most commonly misheard element.
If a tag number is ambiguous or garbled, still emit the row but set status to PEND
and put the raw spoken phrase in notes. Never guess a digit.`,

  general: `You are structuring general field notes from a spoken walkdown.
Split the dictation into discrete observations. Don't invent detail that isn't there.

Return JSON ONLY:
{ "items": [ { "location": "unit/area/equipment or empty", "observation": "what was noted", "followup": "action or empty" } ] }`,

  call: `You are structuring notes from a recorded phone call or meeting for a plant engineer.
Extract one row per distinct topic, decision, or commitment. Merge fragments about the same thing.
A call is not a walkdown: most of it is conversation, and only some of it is a record. Skip
greetings, scheduling chatter and small talk entirely rather than making rows out of them.

Return JSON ONLY:
{ "items": [ { "who": "person or company", "topic": "what was discussed", "action": "what was agreed or happens next", "owner": "ME|THEM|BOTH|NONE" } ] }

Owner rules: ME = the person taking these notes owes the action; THEM = the other party owes it;
BOTH = jointly owned; NONE = informational, nobody owes anything; UNCLEAR = an action is owed but
the transcript does not establish by whom.

CRITICAL: the transcript is a single channel with no speaker labels, and both sides say "I". You
usually CANNOT tell which speaker is the note-taker. Use ME or THEM only when the transcript
itself settles it beyond doubt — for example the other party names themselves, or the note-taker
is clearly answering a question put to them. Otherwise use UNCLEAR. Guessing produces a confident
record of who promised what that is wrong half the time, which is far worse than one marked for
review. When in any doubt, UNCLEAR.

If a name was never stated, leave "who" empty rather than guessing. A wrong attribution in a
record of who promised what is worse than a blank field.

The input is raw speech-to-text of a live call and WILL contain misrecognitions, crosstalk, and
both sides talking over each other. Do not invent detail to smooth over a garbled passage.
Dates, quantities, part numbers and prices are the most commonly misheard: if one is unclear,
keep the row but put the raw spoken phrase in "action" rather than committing to a number.`,
};

const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";
const MAX_TRANSCRIPT = 40_000;   // characters
const MAX_BODY = 200_000;        // bytes

// Best-effort burst limiter. Edge instances are ephemeral and there may be
// several, so this is a speed bump, not a quota.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // crude memory bound
  return list.length > RATE_MAX;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const raw = Deno.env.get("ALLOWED_ORIGINS");
  const allowed = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  let allowOrigin = "*";
  if (allowed) allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "content-type, x-fr-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function originAllowed(origin: string | null): boolean {
  const raw = Deno.env.get("ALLOWED_ORIGINS");
  if (!raw) return true;                 // not configured yet
  if (!origin) return true;              // non-browser caller; secret still applies
  return raw.split(",").map((s) => s.trim()).includes(origin);
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  if (!originAllowed(origin)) return json({ error: "origin_not_allowed" }, 403, cors);

  const secret = Deno.env.get("FR_SHARED_SECRET");
  if (secret && req.headers.get("x-fr-key") !== secret) {
    return json({ error: "unauthorized" }, 401, cors);
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("cf-connecting-ip") ??
    "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429, cors);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "server_misconfigured" }, 500, cors);

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return json({ error: "payload_too_large" }, 413, cors);

  let body: { template?: unknown; transcript?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400, cors);
  }

  const template = typeof body.template === "string" ? body.template : "";
  const transcript = typeof body.transcript === "string" ? body.transcript : "";

  const system = TEMPLATES[template];
  if (!system) return json({ error: "unknown_template" }, 400, cors);
  if (!transcript.trim()) return json({ error: "empty_transcript" }, 400, cors);
  if (transcript.length > MAX_TRANSCRIPT) {
    return json(
      { error: "transcript_too_long", limit: MAX_TRANSCRIPT, got: transcript.length },
      413,
      cors,
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system,
        messages: [
          {
            role: "user",
            content: `---RAW DICTATION---\n${transcript.trim()}\n---END---`,
          },
        ],
      }),
    });
  } catch (e) {
    return json({ error: "upstream_unreachable", detail: String(e).slice(0, 200) }, 502, cors);
  }

  const text = await upstream.text();

  if (!upstream.ok) {
    // Never pass an upstream error body straight through — it can echo
    // request details. Give the client something it can act on instead.
    console.error("anthropic error", upstream.status, text.slice(0, 500));
    const msg =
      upstream.status === 401 ? "API key rejected — check ANTHROPIC_API_KEY"
      : upstream.status === 429 ? "Anthropic rate limit — wait and retry"
      : upstream.status >= 500 ? "Anthropic is having trouble — retry shortly"
      : "Structuring request was rejected";
    return json({ error: "upstream_error", status: upstream.status, message: msg }, 502, cors);
  }

  return new Response(text, {
    status: 200,
    headers: { ...cors, "content-type": "application/json" },
  });
});
