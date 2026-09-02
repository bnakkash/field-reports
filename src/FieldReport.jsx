import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic, Square, ChevronLeft, Copy, Check, Trash2, History, AlertTriangle,
  Loader2, ClipboardList, ListChecks, StickyNote, Plus, Radio, Download,
  WifiOff, RotateCw, Play
} from 'lucide-react';

// ═════════════════════════════════════════════════════════════
// CONFIG
// ═════════════════════════════════════════════════════════════
//
// Point this at YOUR proxy — never at api.anthropic.com.
// A browser cannot hold an API key safely. See notes at the bottom
// of this file for the Supabase Edge Function that backs this.
//
// NOTE: written as a plain `import.meta.env.VITE_…` read so Vite's static
// replacement actually fires — optional chaining on `import.meta` defeats it.
const STRUCTURE_ENDPOINT =
  import.meta.env.VITE_STRUCTURE_ENDPOINT ||
  'https://itxcaamyiilvotfzctit.supabase.co/functions/v1/structure-report';

// Optional. If you set FR_SHARED_SECRET on the Edge Function, set this too.
// It ships in the public bundle — a speed bump against casual abuse, not a secret.
const FR_KEY = import.meta.env.VITE_FR_KEY || '';

const MAX_AUDIO_MS = 90 * 60 * 1000;   // hard stop at 90 min to bound memory
const DRAFT_SAVE_MS = 4000;            // checkpoint interval while recording

// Audio is ~14 MB/hour. Quota is generous once installed to the home screen,
// but nothing should grow without bound on a device you can't easily inspect.
const AUDIO_RETENTION_DAYS = 30;

// The proxy answers with a machine-readable code. Surfacing a raw
// `Server 500: {"error":"server_misconfigured"}` at a piece of equipment
// tells the user nothing they can act on — translate the ones with a remedy.
const PROXY_ERRORS = {
  server_misconfigured:
    'Structuring service has no API key set yet. Use SAVE RAW — the dictation is kept and can be structured later.',
  unauthorized:
    'Structuring service rejected this build’s key (VITE_FR_KEY does not match FR_SHARED_SECRET).',
  origin_not_allowed: 'This origin is not on the structuring service’s allowlist.',
  rate_limited: 'Too many requests in the last minute. Wait a moment, then retry.',
  transcript_too_long: 'Dictation is too long to structure in one pass. Split it into two reports.',
  empty_transcript: 'Nothing to structure — the transcript is empty.',
  unknown_template: 'Structuring service does not recognise this template.',
  upstream_unreachable: 'Could not reach the model service. Check signal and retry.',
};

// ═════════════════════════════════════════════════════════════
// Templates
//
// Shape only — field names, enums, tag validation, and how a row renders.
// The model prompts deliberately live server-side, in
// supabase/functions/structure-report/index.ts. A prompt that ships in the
// bundle is editable by anyone, which turns the proxy into a general-purpose
// LLM endpoint; keeping one copy also stops the two drifting apart.
// ═════════════════════════════════════════════════════════════
const TEMPLATES = {
  punch: {
    id: 'punch',
    name: 'PUNCH LIST',
    code: 'PNCH',
    icon: ListChecks,
    desc: 'Item · Location · Action · Priority',
    fields: ['item', 'location', 'action', 'priority'],
    enums: { priority: ['HIGH', 'MED', 'LOW'] },
    enumDefault: { priority: 'MED' },
  },
  loop: {
    id: 'loop',
    name: 'LOOP CHECK',
    code: 'LOOP',
    icon: ClipboardList,
    desc: 'Tag · Type · Status · Notes',
    fields: ['tag', 'type', 'status', 'notes'],
    enums: { status: ['PASS', 'FAIL', 'PEND', 'BLOCK'] },
    enumDefault: { status: 'PEND' },
    validate: { tag: /^[A-Z]{1,4}-?\d{1,5}[A-Z]?$/ },
  },
  general: {
    id: 'general',
    name: 'FIELD NOTES',
    code: 'NOTE',
    icon: StickyNote,
    desc: 'Location · Observation · Follow-up',
    fields: ['location', 'observation', 'followup'],
    enums: {},
    enumDefault: {},
  },
};

const FONT_MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace";
const FONT_SANS = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif";

const uid = (p = 'i') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ═════════════════════════════════════════════════════════════
// Storage — IndexedDB with a localStorage fallback.
//
// The previous build called window.storage.* , which does not exist
// in a browser. Both helpers were wrapped in try/catch, so every save
// failed silently and every load returned []. Saving a report did
// nothing at all and the UI gave no indication.
// ═════════════════════════════════════════════════════════════
const DB_NAME = 'field-report';
const STORE = 'kv';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no-idb'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function kvGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch {
    try {
      const v = localStorage.getItem(DB_NAME + ':' + key);
      return v ? JSON.parse(v) : undefined;
    } catch { return undefined; }
  }
}

async function kvSet(key, val) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
    return true;
  } catch {
    // Blobs can't go in localStorage — only metadata falls back.
    try {
      if (val instanceof Blob) return false;
      localStorage.setItem(DB_NAME + ':' + key, JSON.stringify(val));
      return true;
    } catch { return false; }
  }
}

async function kvDel(key) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  } catch { /* noop */ }
  try { localStorage.removeItem(DB_NAME + ':' + key); } catch { /* noop */ }
  return true;
}

const loadReports = async () => (await kvGet('reports')) || [];
const saveReports = (reports) => kvSet('reports', reports);

/**
 * Age out stored audio. The transcript and the structured items are the
 * durable record; the audio exists to settle "did it really say FT-101",
 * a question with a short shelf life.
 *
 * RAW captures keep their audio indefinitely — they were never structured,
 * so the recording IS the record.
 */
async function pruneAudio(reports) {
  const cutoff = Date.now() - AUDIO_RETENTION_DAYS * 86400000;
  let changed = false;
  const next = [];
  for (const r of reports) {
    if (r.hasAudio && !r.raw && new Date(r.createdAt).getTime() < cutoff) {
      await kvDel('audio:' + r.id);
      next.push({ ...r, hasAudio: false, audioPruned: true });
      changed = true;
    } else {
      next.push(r);
    }
  }
  if (changed) await saveReports(next);
  return next;
}

// Ask the browser not to evict us. iOS/Safari clears script-writable
// storage for sites it considers idle; this is the only lever we have.
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* noop */ }
}

// ═════════════════════════════════════════════════════════════
// Output validation — never trust model JSON straight into the UI
// ═════════════════════════════════════════════════════════════
function coerceItems(raw, tpl) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 250)
    .map((row) => {
      const out = { _id: uid('it') };
      for (const f of tpl.fields) {
        const v = row?.[f];
        out[f] = typeof v === 'string' ? v.trim().slice(0, 400)
          : typeof v === 'number' ? String(v)
          : '';
      }
      for (const [field, allowed] of Object.entries(tpl.enums || {})) {
        const up = (out[field] || '').toUpperCase();
        out[field] = allowed.includes(up) ? up : (tpl.enumDefault?.[field] || '');
      }
      if (tpl.fields.includes('tag')) out.tag = out.tag.toUpperCase().replace(/\s+/g, '');
      // Flag anything that doesn't look like a real instrument tag so it
      // surfaces for review rather than sliding into a report unnoticed.
      out._suspect = Object.entries(tpl.validate || {}).some(
        ([f, re]) => out[f] && !re.test(out[f])
      );
      return out;
    })
    .filter((o) => tpl.fields.some((f) => o[f]));
}

// ═════════════════════════════════════════════════════════════
// Speech recognition
// ═════════════════════════════════════════════════════════════
function getRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = 'en-US';
  return r;
}

// ═════════════════════════════════════════════════════════════
// App
// ═════════════════════════════════════════════════════════════
export default function FieldReport() {
  const [view, setView] = useState('home');
  const [template, setTemplate] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [recording, setRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [structured, setStructured] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [reports, setReports] = useState([]);
  const [detailReport, setDetailReport] = useState(null);
  const [copied, setCopied] = useState(false);
  const [micError, setMicError] = useState(null);
  const [sttDown, setSttDown] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [draft, setDraft] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [micHeld, setMicHeld] = useState(false);
  // Mirrors pendingAudioRef for rendering. A ref read during render does not
  // re-render, so the "+ AUDIO" affordance used to lag a take behind.
  const [pendingAudio, setPendingAudio] = useState(false);
  // Set while re-structuring an already-saved report; save then replaces that
  // report in place instead of logging a second copy of the same walkdown.
  const [restructureId, setRestructureId] = useState(null);

  const recRef = useRef(null);
  const shouldRestartRef = useRef(false);
  const restartCountRef = useRef(0);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const mediaRecRef = useRef(null);
  const chunksRef = useRef([]);
  const wakeRef = useRef(null);
  const audioLimitRef = useRef(null);
  const draftTimerRef = useRef(null);
  const interimRef = useRef('');
  const transcriptRef = useRef('');
  const templateRef = useRef(null);

  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { templateRef.current = template; }, [template]);

  // ─── fonts ───
  useEffect(() => {
    const id = 'ibm-plex-font';
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href =
        'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap';
      document.head.appendChild(link);
    }
  }, []);

  // ─── boot: reports, draft recovery, persistence ───
  useEffect(() => {
    requestPersistence();
    loadReports().then(pruneAudio).then(setReports);
    kvGet('draft').then((d) => { if (d?.transcript?.trim()) setDraft(d); });
  }, []);

  // ─── connectivity ───
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // ─── wake lock: a walkdown outlasts the screen timeout ───
  const acquireWake = useCallback(async () => {
    try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
  }, []);
  const releaseWake = useCallback(() => {
    try { wakeRef.current?.release(); } catch { /* noop */ }
    wakeRef.current = null;
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && recording && !wakeRef.current) acquireWake();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [recording, acquireWake]);

  // ─── draft checkpointing ───
  const saveDraft = useCallback(() => {
    if (!templateRef.current) return;
    kvSet('draft', {
      template: templateRef.current,
      transcript: transcriptRef.current,
      at: new Date().toISOString(),
    });
  }, []);

  const clearDraft = useCallback(() => { kvDel('draft'); setDraft(null); }, []);

  // ─── capture ───
  //
  // The microphone stream is a SESSION SINGLETON, deliberately.
  //
  // Safari on iOS treats a getUserMedia call as a fresh permission request
  // whenever the previous stream's tracks were stopped. Tearing the stream
  // down after every recording is what makes it prompt every single time.
  // So we acquire once and hold it, and only release when the user actually
  // leaves the record screen or the app goes away.
  //
  // The cost is honesty: while held, iOS shows the orange mic indicator and
  // the app really does have the mic open. That is why releaseMic() is wired
  // to leaving the view, to unmount, and to a visible control — not hidden.

  const ensureStream = useCallback(async () => {
    const live =
      streamRef.current &&
      streamRef.current.getAudioTracks().some((t) => t.readyState === 'live');
    if (live) return streamRef.current;

    // Anything stale gets dropped before asking again.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;

    // Build the analyser graph once, against the long-lived stream.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyserRef.current = analyser;

    setMicHeld(true);
    return stream;
  }, []);

  const releaseMic = useCallback(async () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { await audioCtxRef.current.close(); } catch { /* noop */ }
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
    setMicHeld(false);
  }, []);

  const startCapture = useCallback(async () => {
    try {
      const stream = await ensureStream();
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') await ctx.resume();

      // Keep the audio. Speech-to-text mishears digits, and a tag number
      // is exactly the thing you cannot reconstruct from memory later.
      chunksRef.current = [];
      try {
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
        const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
        mr.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
        mr.start(5000); // flush every 5s so a crash costs at most 5s
        mediaRecRef.current = mr;
        // Held in a ref and cleared on stop. Untracked, every take left a live
        // 90-minute timer and its closure behind for the rest of the session.
        if (audioLimitRef.current) clearTimeout(audioLimitRef.current);
        audioLimitRef.current = setTimeout(() => {
          try { mr.state !== 'inactive' && mr.stop(); } catch { /* noop */ }
        }, MAX_AUDIO_MS);
      } catch { mediaRecRef.current = null; }

      const analyser = analyserRef.current;
      if (analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          setAudioLevel(Math.min(1, sum / data.length / 80));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      }
      return true;
    } catch (e) {
      setMicError(
        e.name === 'NotAllowedError'
          ? 'Microphone permission denied. Settings → Safari → Microphone, or tap AA in the address bar → Website Settings.'
          : e.message || 'Microphone unavailable'
      );
      return false;
    }
  }, [ensureStream]);

  // Stops the RECORDING. Deliberately does NOT stop the tracks — see above.
  const stopCapture = useCallback(async () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (audioLimitRef.current) { clearTimeout(audioLimitRef.current); audioLimitRef.current = null; }

    let blob = null;
    const mr = mediaRecRef.current;
    if (mr && mr.state !== 'inactive') {
      blob = await new Promise((resolve) => {
        mr.onstop = () => {
          const type = mr.mimeType || 'audio/webm';
          resolve(chunksRef.current.length ? new Blob(chunksRef.current, { type }) : null);
        };
        try { mr.stop(); } catch { resolve(null); }
      });
    }
    mediaRecRef.current = null;
    setAudioLevel(0);
    return blob;
  }, []);

  const pendingAudioRef = useRef(null);

  // ─── recording control ───
  const startRecording = useCallback(async () => {
    setMicError(null);
    setSttDown(false);
    restartCountRef.current = 0;

    const ok = await startCapture();
    if (!ok) return;
    acquireWake();

    const rec = getRecognizer();
    if (!rec) {
      // No STT available — still record audio so the walkdown isn't lost.
      setSttDown(true);
      setMicError('Speech recognition unavailable in this browser. Audio is still being recorded — you can transcribe it later.');
      setRecording(true);
      draftTimerRef.current = setInterval(saveDraft, DRAFT_SAVE_MS);
      return;
    }
    recRef.current = rec;

    rec.onresult = (e) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript + ' ';
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) {
        restartCountRef.current = 0;
        // Only normalize the incoming chunk — the old code re-collapsed
        // whitespace across the whole accumulated transcript on every result.
        const clean = finalChunk.replace(/\s+/g, ' ');
        setTranscript((t) => (t ? t.replace(/\s+$/, '') + ' ' : '') + clean.trim() + ' ');
      }
      interimRef.current = interimChunk;
      setInterim(interimChunk);
    };

    rec.onend = () => {
      if (shouldRestartRef.current) {
        // Safari ends the session on its own; restart to keep going.
        // Bounded, so a persistent failure can't spin forever on battery.
        if (restartCountRef.current > 40) {
          shouldRestartRef.current = false;
          setSttDown(true);
          setMicError('Speech service kept dropping. Audio is still recording — stop when done and transcribe later.');
          return;
        }
        restartCountRef.current += 1;
        setTimeout(() => { try { rec.start(); } catch { /* already running */ } }, 250);
      } else {
        // Stopping mid-sentence used to throw away whatever was still interim.
        // Chrome normally promotes that utterance to a final result before
        // onend fires — in which case interimRef is already empty and nothing
        // is appended — so this recovers the Safari case without double-writing.
        const tail = interimRef.current.trim();
        interimRef.current = '';
        if (tail) setTranscript((t) => (t ? t.replace(/\s+$/, '') + ' ' : '') + tail + ' ');
        setInterim('');
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setMicError('Microphone permission denied. Enable in Settings → Safari → Microphone.');
        shouldRestartRef.current = false;
        setSttDown(true);
      } else if (e.error === 'network') {
        // The plant dead-zone case. STT is server-side; it cannot work here.
        // Do NOT keep restarting — audio capture continues regardless.
        shouldRestartRef.current = false;
        setSttDown(true);
      } else if (e.error === 'no-speech' || e.error === 'aborted') {
        // benign; onend handles restart
      } else {
        setMicError('Recognizer error: ' + e.error);
      }
    };

    shouldRestartRef.current = true;
    try {
      rec.start();
      setRecording(true);
      draftTimerRef.current = setInterval(saveDraft, DRAFT_SAVE_MS);
    } catch (err) {
      setMicError('Could not start recognizer: ' + err.message);
      await stopCapture();
      releaseWake();
    }
  }, [startCapture, stopCapture, acquireWake, releaseWake, saveDraft]);

  const stopRecording = useCallback(async () => {
    shouldRestartRef.current = false;
    if (recRef.current) { try { recRef.current.stop(); } catch { /* noop */ } }
    if (draftTimerRef.current) { clearInterval(draftTimerRef.current); draftTimerRef.current = null; }
    const blob = await stopCapture();
    pendingAudioRef.current = blob;
    setPendingAudio(!!blob);
    releaseWake();
    setRecording(false);
    setInterim('');
    saveDraft();
  }, [stopCapture, releaseWake, saveDraft]);

  // ─── structure via proxy ───
  const structure = useCallback(async () => {
    if (!transcript.trim() || !template) return;
    setProcessing(true);
    setApiError(null);
    try {
      const tpl = TEMPLATES[template];
      const res = await fetch(STRUCTURE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(FR_KEY ? { 'x-fr-key': FR_KEY } : {}),
        },
        body: JSON.stringify({ template: tpl.id, transcript: transcript.trim() }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let code = '';
        let upstreamMsg = '';
        try {
          const err = JSON.parse(body);
          code = err?.error || '';
          upstreamMsg = err?.message || '';
        } catch { /* not JSON — fall through to the raw body */ }
        throw new Error(
          PROXY_ERRORS[code] || upstreamMsg ||
          `Server ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`
        );
      }

      const data = await res.json();

      if (data.stop_reason === 'max_tokens') {
        throw new Error('Response was truncated — the dictation is too long. Split it into two reports.');
      }

      const text = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error('Could not parse model output as JSON');
      }

      setStructured(coerceItems(parsed.items, tpl));
      setView('review');
    } catch (e) {
      setApiError(
        online
          ? (e.message || 'Unknown error')
          : 'Offline — transcript is saved. Use SAVE RAW and structure it when you have signal.'
      );
    } finally {
      setProcessing(false);
    }
  }, [transcript, template, online]);

  const reset = useCallback(() => {
    setTranscript('');
    setInterim('');
    setStructured(null);
    setTemplate(null);
    setApiError(null);
    setSttDown(false);
    setMicError(null);
    setRestructureId(null);
    pendingAudioRef.current = null;
    setPendingAudio(false);
    interimRef.current = '';
    // Leaving the record screen is the natural point to hand the mic back.
    // Within the screen we hold it, so iOS does not re-prompt on every take.
    releaseMic();
  }, [releaseMic]);

  // Navigating away used to leave SpeechRecognition running. It does not use
  // the getUserMedia stream, so releaseMic() never stopped it: `recording`
  // stayed true and final results kept appending to a transcript that was no
  // longer on screen. Stop (which also checkpoints the draft) before leaving.
  const leaveTo = useCallback(async (next) => {
    if (recording) await stopRecording();
    if (next === 'home') reset();
    setView(next);
  }, [recording, stopRecording, reset]);

  // ─── save ───
  const persistReport = useCallback(async (items, isRaw) => {
    if (!template) return;

    // Structuring a report that was already saved REPLACES it under the same
    // id rather than logging a second copy of one walkdown — which also keeps
    // its 'audio:<id>' blob attached for free instead of orphaning it.
    const existing = restructureId ? reports.find((r) => r.id === restructureId) : null;
    const id = existing ? existing.id : 'r_' + Date.now().toString(36);

    let hasAudio = existing ? !!existing.hasAudio : false;
    if (pendingAudioRef.current) {
      hasAudio = (await kvSet('audio:' + id, pendingAudioRef.current)) || hasAudio;
    }

    const report = {
      ...(existing || {}),
      id,
      template,
      templateName: TEMPLATES[template].name,
      templateCode: TEMPLATES[template].code,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      items: items || [],
      transcript,
      hasAudio,
      raw: !!isRaw,
    };
    if (existing && !isRaw) report.structuredAt = new Date().toISOString();

    const next = existing
      ? reports.map((r) => (r.id === id ? report : r))
      : [report, ...reports];

    const ok = await saveReports(next);
    if (!ok) {
      setApiError('Could not write to device storage. Copy this report before leaving the page.');
      return;
    }
    pendingAudioRef.current = null;
    setReports(next);
    setCopied(false);
    clearDraft();
    reset();
    setView('history');
  }, [template, transcript, reports, clearDraft, reset, restructureId]);

  const handleSave = useCallback(() => persistReport(structured, false), [persistReport, structured]);
  const handleSaveRaw = useCallback(() => persistReport([], true), [persistReport]);

  // The other half of "SAVE RAW — STRUCTURE LATER": pull a saved report back
  // into the record screen, transcript intact and editable, so GENERATE can
  // run against it once there is signal. Saving then replaces it in place.
  const restructure = useCallback((report) => {
    setTemplate(report.template);
    setTranscript(report.transcript || '');
    setStructured(null);
    setApiError(null);
    setMicError(null);
    setSttDown(false);
    // A take abandoned on the way here (record → stop → LOG → open a report)
    // leaves a blob pending, and persistReport would file it under THIS
    // report's id. The report's own audio survives via existing.hasAudio.
    pendingAudioRef.current = null;
    setPendingAudio(false);
    setRestructureId(report.id);
    setDetailReport(null);
    setView('record');
  }, []);

  const handleDelete = useCallback(
    async (id) => {
      const next = reports.filter((r) => r.id !== id);
      const ok = await saveReports(next);
      if (ok) {
        await kvDel('audio:' + id);
        setReports(next);
        setConfirmDelete(null);
        if (detailReport?.id === id) { setDetailReport(null); setView('history'); }
      }
    },
    [reports, detailReport]
  );

  const restoreDraft = useCallback(() => {
    if (!draft) return;
    setTemplate(draft.template);
    setTranscript(draft.transcript);
    setDraft(null);
    setView('record');
  }, [draft]);

  // ─── export ───
  const reportText = useCallback((items, tplId, createdAt, transcriptText = '') => {
    const tpl = TEMPLATES[tplId];
    const header = `${tpl.name}  ${new Date(createdAt || Date.now()).toLocaleString()}\n${'─'.repeat(40)}`;
    // A raw capture has no rows — its transcript IS the record. Copying it
    // used to hand over a bare header, which looks like a successful copy of
    // nothing until you paste it into an email.
    if (!items.length) {
      return header + '\nRAW CAPTURE — not structured\n\n' +
        (transcriptText.trim() || '(no transcript)');
    }
    const rows = items.map((it, i) => {
      const parts = tpl.fields.map((f) => `${f.toUpperCase()}: ${it[f] || '—'}`);
      return `[${String(i + 1).padStart(2, '0')}] ${parts.join(' · ')}`;
    });
    return header + '\n' + rows.join('\n');
  }, []);

  const copyReport = useCallback(async (items, tplId, createdAt, transcriptText = '') => {
    const body = reportText(items, tplId, createdAt, transcriptText);
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API fails on some iOS configurations — fall back visibly
      // rather than swallowing it, which is what the old code did.
      window.prompt('Copy failed. Select and copy manually:', body);
    }
  }, [reportText]);

  const exportCSV = useCallback((items, tplId, createdAt, transcriptText = '') => {
    const tpl = TEMPLATES[tplId];
    const esc = (s) => {
      const v = String(s ?? '');
      // Excel and Sheets execute a cell that opens with = + - @. A dictated
      // "-40 degrees at the exchanger" is a formula to them, so neutralise it.
      const safe = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    // Same reason as reportText: a raw capture exported one header row and no
    // data. Export what it actually holds instead.
    const csv = items.length
      ? [
          tpl.fields.map((f) => esc(f.toUpperCase())).join(','),
          ...items.map((it) => tpl.fields.map((f) => esc(it[f])).join(',')),
        ].join('\r\n')
      : ['TRANSCRIPT', esc(transcriptText)].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tpl.code}_${new Date(createdAt || Date.now()).toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  // ─── cleanup ───
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      if (recRef.current) { try { recRef.current.stop(); } catch { /* noop */ } }
      if (draftTimerRef.current) clearInterval(draftTimerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch { /* noop */ } }
      // (refs are read directly here; releaseMic's setState would be a no-op on an unmounted tree)
      try { wakeRef.current?.release(); } catch { /* noop */ }
    };
  }, []);

  return (
    <div
      className="fr-app-shell w-full text-stone-100"
      style={{
        fontFamily: FONT_SANS,
        backgroundColor: '#0a0a0a',
        backgroundImage:
          'radial-gradient(circle at 1px 1px, rgba(251, 191, 36, 0.06) 1px, transparent 0)',
        backgroundSize: '24px 24px',
      }}
    >
      <div className="fr-app-frame mx-auto max-w-xl flex flex-col">
        <Header
          view={view}
          online={online}
          onHome={() => leaveTo('home')}
          onHistory={() => leaveTo('history')}
          reports={reports}
        />

        <main className="fr-app-main flex-1">
          {draft && view === 'home' && (
            <DraftBanner draft={draft} onRestore={restoreDraft} onDiscard={clearDraft} />
          )}

          {view === 'home' && (
            <HomeView
              onPick={(id) => {
                setTemplate(id);
                setTranscript('');
                setStructured(null);
                setView('record');
              }}
            />
          )}

          {view === 'record' && template && (
            <RecordView
              template={TEMPLATES[template]}
              transcript={transcript}
              interim={interim}
              recording={recording}
              audioLevel={audioLevel}
              onStart={startRecording}
              onStop={stopRecording}
              onClear={() => { setTranscript(''); clearDraft(); }}
              onStructure={structure}
              onSaveRaw={handleSaveRaw}
              processing={processing}
              apiError={apiError}
              micError={micError}
              sttDown={sttDown}
              online={online}
              hasAudio={pendingAudio}
              restructuring={!!restructureId}
              onTranscriptEdit={setTranscript}
              micHeld={micHeld}
              onReleaseMic={releaseMic}
            />
          )}

          {view === 'review' && structured && template && (
            <ReviewView
              template={TEMPLATES[template]}
              items={structured}
              setItems={setStructured}
              onSave={handleSave}
              onCopy={() => copyReport(structured, template, null, transcript)}
              onCSV={() => exportCSV(structured, template, null, transcript)}
              copied={copied}
              onBack={() => setView('record')}
              apiError={apiError}
            />
          )}

          {view === 'history' && (
            <HistoryView
              reports={reports}
              onOpen={(r) => { setDetailReport(r); setView('detail'); }}
              onDelete={(id) => setConfirmDelete(id)}
              confirmDelete={confirmDelete}
              onConfirm={handleDelete}
              onCancelDelete={() => setConfirmDelete(null)}
              onNew={() => { reset(); setView('home'); }}
            />
          )}

          {view === 'detail' && detailReport && (
            <DetailView
              report={detailReport}
              onCopy={() => copyReport(detailReport.items, detailReport.template, detailReport.createdAt, detailReport.transcript)}
              onCSV={() => exportCSV(detailReport.items, detailReport.template, detailReport.createdAt, detailReport.transcript)}
              copied={copied}
              onDelete={() => setConfirmDelete(detailReport.id)}
              confirming={confirmDelete === detailReport.id}
              onConfirm={() => handleDelete(detailReport.id)}
              onCancelDelete={() => setConfirmDelete(null)}
              onBack={() => { setDetailReport(null); setView('history'); }}
              onRestructure={() => restructure(detailReport)}
              online={online}
            />
          )}
        </main>

        <Footer online={online} />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Header
// ═════════════════════════════════════════════════════════════
function Header({ view, onHome, onHistory, reports, online }) {
  return (
    <header className="fr-app-header pb-3 flex items-center justify-between border-b border-stone-800">
      <button onClick={onHome} className="flex items-center gap-2 group py-2 -my-2">
        <div
          className="w-2 h-2 rounded-full bg-amber-400"
          style={{ boxShadow: '0 0 8px rgba(251, 191, 36, 0.8)' }}
        />
        <span
          className="text-stone-400 group-hover:text-amber-300 transition-colors"
          style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: '10px', letterSpacing: '0.3em' }}
        >
          FIELD·REPORT
        </span>
      </button>
      <div className="flex items-center gap-2">
        {!online && (
          <span
            className="flex items-center gap-1 px-2 py-1 border border-amber-500/40 text-amber-400 rounded"
            style={{ fontFamily: FONT_MONO, fontSize: '9px', letterSpacing: '0.2em' }}
          >
            <WifiOff size={10} /> OFFLINE
          </span>
        )}
        <button
          onClick={onHistory}
          className={`flex items-center gap-1.5 px-3 py-2 rounded border transition-colors ${
            view === 'history'
              ? 'border-amber-400/50 text-amber-300 bg-amber-400/5'
              : 'border-stone-700 text-stone-400 hover:text-stone-200'
          }`}
          style={{ fontFamily: FONT_MONO, fontWeight: 500, fontSize: '10px', letterSpacing: '0.2em' }}
        >
          <History size={11} />
          LOG · {String(reports.length).padStart(3, '0')}
        </button>
      </div>
    </header>
  );
}

// ═════════════════════════════════════════════════════════════
// Draft recovery
// ═════════════════════════════════════════════════════════════
function DraftBanner({ draft, onRestore, onDiscard }) {
  const words = draft.transcript.trim().split(/\s+/).length;
  return (
    <div className="mt-5 p-3 border border-amber-400/40 bg-amber-400/5 rounded-sm">
      <div className="flex items-center gap-2 mb-2">
        <RotateCw size={13} className="text-amber-400" />
        <span className="text-amber-300" style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}>
          UNFINISHED DICTATION
        </span>
      </div>
      <div className="text-xs text-stone-400 mb-3" style={{ fontFamily: FONT_MONO }}>
        {TEMPLATES[draft.template]?.name} · {words} words · {new Date(draft.at).toLocaleString()}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onRestore}
          className="flex-1 py-2.5 bg-amber-400 text-stone-950 rounded-sm"
          style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: '11px', letterSpacing: '0.1em' }}
        >
          RESUME
        </button>
        <button
          onClick={onDiscard}
          className="px-4 py-2.5 border border-stone-700 text-stone-400 rounded-sm"
          style={{ fontFamily: FONT_MONO, fontSize: '11px', letterSpacing: '0.1em' }}
        >
          DISCARD
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Home
// ═════════════════════════════════════════════════════════════
function HomeView({ onPick }) {
  return (
    <div className="pt-8">
      <div className="mb-8">
        <div className="text-stone-500 mb-1" style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.3em' }}>
          STEP 01 / SELECT TEMPLATE
        </div>
        <h1
          className="text-3xl text-stone-100 leading-tight"
          style={{ fontFamily: FONT_SANS, fontWeight: 300, letterSpacing: '-0.02em' }}
        >
          What are you<br />
          <span className="text-amber-400" style={{ fontWeight: 500 }}>dictating?</span>
        </h1>
      </div>

      <div className="space-y-3">
        {Object.values(TEMPLATES).map((tpl) => {
          const Icon = tpl.icon;
          return (
            <button
              key={tpl.id}
              onClick={() => onPick(tpl.id)}
              className="group w-full text-left p-5 border border-stone-800 hover:border-amber-400/40 bg-stone-950 hover:bg-stone-900 transition-all rounded-sm relative"
            >
              <span className="absolute top-0 left-0 w-2 h-2 border-t border-l border-amber-400/0 group-hover:border-amber-400/60 transition-colors" />
              <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-amber-400/0 group-hover:border-amber-400/60 transition-colors" />
              <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-amber-400/0 group-hover:border-amber-400/60 transition-colors" />
              <span className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-amber-400/0 group-hover:border-amber-400/60 transition-colors" />

              <div className="flex items-start gap-4">
                <div className="mt-1 p-2 border border-stone-700 group-hover:border-amber-400/50 transition-colors">
                  <Icon size={18} className="text-stone-400 group-hover:text-amber-300 transition-colors" />
                </div>
                <div className="flex-1">
                  <div className="flex items-baseline gap-3 mb-1">
                    <span className="text-lg text-stone-100 tracking-wide" style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>
                      {tpl.name}
                    </span>
                    <span className="text-stone-600" style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}>
                      [{tpl.code}]
                    </span>
                  </div>
                  <div className="text-xs text-stone-500" style={{ fontFamily: FONT_MONO }}>
                    {tpl.desc}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Record
// ═════════════════════════════════════════════════════════════
function RecordView({
  template, transcript, interim, recording, audioLevel,
  onStart, onStop, onClear, onStructure, onSaveRaw, processing,
  apiError, micError, sttDown, online, hasAudio, onTranscriptEdit,
  micHeld, onReleaseMic, restructuring,
}) {
  const hasContent = transcript.trim().length > 0;
  const [editing, setEditing] = useState(false);

  return (
    <div className="pt-6 flex flex-1 flex-col">
      <div className="flex items-center gap-2 mb-4">
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{
            backgroundColor: recording ? '#ef4444' : '#fbbf24',
            boxShadow: recording ? '0 0 8px rgba(239, 68, 68, 0.9)' : '0 0 6px rgba(251, 191, 36, 0.6)',
            animation: recording ? 'fr-pulse 1s ease-in-out infinite' : 'none',
          }}
        />
        <span className="text-stone-400" style={{ fontFamily: FONT_MONO, fontWeight: 500, fontSize: '10px', letterSpacing: '0.3em' }}>
          {recording ? 'REC' : 'ARMED'} · {template.name} [{template.code}]
        </span>
        {micHeld && !recording && (
          <button
            onClick={onReleaseMic}
            className="ml-auto px-2 py-1.5 border border-stone-700 text-stone-500 hover:text-amber-300 rounded-sm"
            style={{ fontFamily: FONT_MONO, fontSize: '9px', letterSpacing: '0.15em' }}
            title="The mic stays open between takes so iOS does not re-prompt. Tap to hand it back."
          >
            MIC HELD ✕
          </button>
        )}
      </div>

      {restructuring && (
        <div className="mb-4 p-3 border border-amber-400/40 bg-amber-400/5 rounded-sm flex gap-2">
          <RotateCw size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-200/90 leading-relaxed" style={{ fontFamily: FONT_MONO }}>
            <strong>STRUCTURING A SAVED REPORT.</strong> This replaces that log entry
            in place — same timestamp, same audio. Fix any misheard tag in the
            transcript first; the model only ever sees what is here.
          </div>
        </div>
      )}

      {/* STT down but audio still capturing — the plant dead-zone case */}
      {sttDown && (
        <div className="mb-4 p-3 border border-amber-500/50 bg-amber-500/5 rounded-sm flex gap-2">
          <WifiOff size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-200/90 leading-relaxed" style={{ fontFamily: FONT_MONO }}>
            <strong>SPEECH SERVICE UNAVAILABLE.</strong> Transcription needs a network connection —
            it runs on Apple/Google servers, not on the phone. Audio is still being captured.
            Finish the walkdown, save, and structure it when you have signal.
          </div>
        </div>
      )}

      <div className="flex-1 mb-6">
        <div
          className="p-4 border border-stone-800 bg-stone-950 rounded-sm relative"
          style={{ fontFamily: FONT_MONO, minHeight: '220px' }}
        >
          <div className="absolute top-2 right-3 tracking-widest text-stone-700" style={{ fontSize: '9px' }}>
            TRANSCRIPT
          </div>
          {!hasContent && !interim && (
            <div className="text-stone-600 text-sm pt-4">
              {recording
                ? 'Listening… speak naturally. Say tag numbers, locations, actions.'
                : 'Press record and describe what you see. Tap stop when done.'}
            </div>
          )}
          {hasContent && !editing && (
            <div className="text-sm text-stone-200 leading-relaxed whitespace-pre-wrap">
              {transcript}
            </div>
          )}
          {hasContent && editing && (
            <textarea
              value={transcript}
              onChange={(e) => onTranscriptEdit(e.target.value)}
              className="w-full bg-transparent text-sm text-stone-200 leading-relaxed outline-none resize-y"
              style={{ fontFamily: FONT_MONO, minHeight: '200px' }}
            />
          )}
          {interim && (
            <div className="text-sm text-stone-500 italic leading-relaxed mt-1">
              {interim}
            </div>
          )}
        </div>
        {hasContent && !recording && (
          <div className="flex gap-4 mt-2">
            <button
              onClick={() => setEditing((v) => !v)}
              className="text-stone-500 hover:text-amber-300 transition-colors py-2"
              style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
            >
              {editing ? '✓ DONE EDITING' : '✎ FIX MISHEARD WORDS'}
            </button>
            <button
              onClick={onClear}
              className="text-stone-600 hover:text-red-400 transition-colors py-2"
              style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
            >
              ↻ CLEAR
            </button>
          </div>
        )}
      </div>

      {(micError || apiError) && (
        <div className="mb-4 p-3 border border-red-900/60 bg-red-950/30 rounded-sm flex gap-2">
          <AlertTriangle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-red-300 leading-relaxed" style={{ fontFamily: FONT_MONO }}>
            {micError || apiError}
          </div>
        </div>
      )}

      <div className="flex flex-col items-center gap-4 pb-4">
        <div className="w-full max-w-xs h-1 bg-stone-900 rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-75"
            style={{
              width: `${recording ? audioLevel * 100 : 0}%`,
              backgroundColor: audioLevel > 0.7 ? '#ef4444' : '#fbbf24',
              boxShadow: recording ? '0 0 8px currentColor' : 'none',
            }}
          />
        </div>

        <button
          onClick={recording ? onStop : onStart}
          disabled={processing}
          className="relative w-24 h-24 rounded-full border-2 flex items-center justify-center transition-all active:scale-95"
          style={{
            borderColor: recording ? '#ef4444' : '#fbbf24',
            backgroundColor: recording ? 'rgba(239, 68, 68, 0.12)' : 'rgba(251, 191, 36, 0.08)',
            boxShadow: recording
              ? '0 0 24px rgba(239, 68, 68, 0.5), inset 0 0 12px rgba(239, 68, 68, 0.2)'
              : '0 0 20px rgba(251, 191, 36, 0.3)',
          }}
        >
          {recording ? (
            <Square size={30} className="text-red-400" fill="currentColor" />
          ) : (
            <Mic size={32} className="text-amber-400" />
          )}
          {recording && (
            <span
              className="absolute inset-0 rounded-full border-2 border-red-500/60"
              style={{ animation: 'fr-ring 1.6s ease-out infinite' }}
            />
          )}
        </button>

        <div className="text-stone-500" style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.3em' }}>
          {recording ? 'TAP TO STOP' : hasContent ? 'TAP TO RESUME' : 'TAP TO RECORD'}
        </div>

        {hasContent && !recording && (
          <div className="w-full flex flex-col gap-2 mt-2">
            <button
              onClick={onStructure}
              disabled={processing || !online}
              className="w-full px-6 py-4 bg-amber-400 hover:bg-amber-300 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 flex items-center justify-center gap-2 rounded-sm transition-colors"
              style={{ fontFamily: FONT_MONO, letterSpacing: '0.15em', fontWeight: 600, fontSize: '12px' }}
            >
              {processing ? (
                <><Loader2 size={14} className="animate-spin" /> STRUCTURING…</>
              ) : online ? 'GENERATE REPORT →' : 'NO SIGNAL — CANNOT STRUCTURE'}
            </button>
            <button
              onClick={onSaveRaw}
              className="w-full px-6 py-3 border border-stone-700 hover:border-amber-400/50 text-stone-300 rounded-sm transition-colors"
              style={{ fontFamily: FONT_MONO, letterSpacing: '0.12em', fontWeight: 500, fontSize: '11px' }}
            >
              {restructuring
                ? 'LEAVE AS RAW — STRUCTURE LATER'
                : `SAVE RAW ${hasAudio ? '+ AUDIO ' : ''}— STRUCTURE LATER`}
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes fr-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes fr-ring { 0% { transform: scale(1); opacity: 0.8; } 100% { transform: scale(1.45); opacity: 0; } }
      `}</style>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Review
// ═════════════════════════════════════════════════════════════
function ReviewView({ template, items, setItems, onSave, onCopy, onCSV, copied, onBack, apiError }) {
  const updateItem = (id, field, val) =>
    setItems(items.map((it) => (it._id === id ? { ...it, [field]: val } : it)));
  const removeItem = (id) => setItems(items.filter((it) => it._id !== id));
  const suspects = items.filter((i) => i._suspect).length;

  return (
    <div className="pt-6">
      <button
        onClick={onBack}
        className="text-stone-500 hover:text-amber-300 flex items-center gap-1 mb-5 py-2"
        style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
      >
        <ChevronLeft size={12} /> BACK TO TRANSCRIPT
      </button>

      <div className="mb-5">
        <div className="text-stone-500 mb-1" style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.3em' }}>
          STEP 03 / REVIEW · {items.length} ITEM{items.length !== 1 ? 'S' : ''}
        </div>
        <h2 className="text-2xl text-stone-100" style={{ fontFamily: FONT_SANS, fontWeight: 300, letterSpacing: '-0.02em' }}>
          <span className="text-amber-400" style={{ fontWeight: 500 }}>{template.name}</span>
        </h2>
      </div>

      {suspects > 0 && (
        <div className="mb-4 p-3 border border-amber-500/40 bg-amber-500/5 rounded-sm text-xs text-amber-200/90" style={{ fontFamily: FONT_MONO }}>
          {suspects} tag{suspects !== 1 ? 's' : ''} did not match the expected format and {suspects !== 1 ? 'are' : 'is'} flagged below.
          Speech-to-text mishears digits — check these against the loop sheet before this leaves your phone.
        </div>
      )}

      {apiError && (
        <div className="mb-4 p-3 border border-red-900/60 bg-red-950/30 rounded-sm text-xs text-red-300" style={{ fontFamily: FONT_MONO }}>
          {apiError}
        </div>
      )}

      <div className="space-y-3 mb-6">
        {items.length === 0 && (
          <div className="p-6 border border-stone-800 bg-stone-950 text-sm text-stone-500 text-center rounded-sm" style={{ fontFamily: FONT_MONO }}>
            No items extracted. Go back and check the transcript.
          </div>
        )}
        {items.map((item, idx) => (
          <ItemCard
            key={item._id}
            idx={idx}
            item={item}
            template={template}
            onUpdate={(f, v) => updateItem(item._id, f, v)}
            onRemove={() => removeItem(item._id)}
          />
        ))}
      </div>

      <div className="fr-sticky-actions flex gap-2 sticky">
        <button
          onClick={onCopy}
          className="flex-1 px-3 py-4 border border-stone-700 hover:border-amber-400/60 text-stone-200 flex items-center justify-center gap-2 transition-colors rounded-sm bg-stone-950"
          style={{ fontFamily: FONT_MONO, fontWeight: 500, letterSpacing: '0.1em', fontSize: '11px' }}
        >
          {copied ? <><Check size={14} /> COPIED</> : <><Copy size={14} /> COPY</>}
        </button>
        <button
          onClick={onCSV}
          className="px-4 py-4 border border-stone-700 hover:border-amber-400/60 text-stone-300 transition-colors rounded-sm bg-stone-950"
          aria-label="Export CSV"
        >
          <Download size={14} />
        </button>
        <button
          onClick={onSave}
          disabled={items.length === 0}
          className="flex-1 px-3 py-4 bg-amber-400 hover:bg-amber-300 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 flex items-center justify-center gap-2 transition-colors rounded-sm"
          style={{ fontFamily: FONT_MONO, fontWeight: 600, letterSpacing: '0.1em', fontSize: '11px' }}
        >
          SAVE TO LOG →
        </button>
      </div>
    </div>
  );
}

function ItemCard({ idx, item, template, onUpdate, onRemove }) {
  const statusColor = (s) => {
    const v = (s || '').toUpperCase();
    if (v === 'FAIL' || v === 'BLOCK' || v === 'HIGH') return '#ef4444';
    if (v === 'PASS' || v === 'LOW') return '#10b981';
    if (v === 'MED' || v === 'PEND') return '#fbbf24';
    return '#78716c';
  };

  return (
    <div
      className="border bg-stone-950 p-3 rounded-sm relative"
      style={{ borderColor: item._suspect ? 'rgba(245,158,11,0.5)' : 'rgb(41,37,36)' }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="tracking-widest text-stone-600" style={{ fontFamily: FONT_MONO, fontSize: '10px' }}>
          [{String(idx + 1).padStart(2, '0')}]
          {item._suspect && <span className="ml-2 text-amber-400">⚑ CHECK TAG</span>}
        </span>
        <button
          onClick={onRemove}
          className="text-stone-600 hover:text-red-400 transition-colors p-2.5 -m-1"
          aria-label="Remove item"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="space-y-1.5">
        {template.fields.map((field) => {
          const val = item[field] || '';
          const isEnum = !!template.enums?.[field];
          return (
            <div key={field} className="flex items-start gap-2">
              <span
                className="tracking-widest text-stone-500 pt-2 w-16 flex-shrink-0"
                style={{ fontFamily: FONT_MONO, fontSize: '9px' }}
              >
                {field.toUpperCase()}
              </span>
              {isEnum ? (
                <div className="flex items-center gap-1.5 flex-1">
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: statusColor(val), boxShadow: `0 0 4px ${statusColor(val)}` }}
                  />
                  <select
                    value={val}
                    onChange={(e) => onUpdate(field, e.target.value)}
                    className="flex-1 bg-transparent text-sm text-stone-100 border-b border-stone-800 focus:border-amber-400/60 focus:outline-none py-2"
                    style={{ fontFamily: FONT_MONO }}
                  >
                    {template.enums[field].map((o) => (
                      <option key={o} value={o} style={{ backgroundColor: '#0a0a0a' }}>{o}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <input
                  value={val}
                  onChange={(e) => onUpdate(field, e.target.value)}
                  className={`flex-1 bg-transparent text-sm text-stone-100 border-b border-stone-800 focus:border-amber-400/60 focus:outline-none py-2 ${
                    field === 'tag' ? 'tracking-wider' : ''
                  }`}
                  style={{ fontFamily: field === 'tag' || field === 'type' ? FONT_MONO : FONT_SANS }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// History
// ═════════════════════════════════════════════════════════════
function HistoryView({ reports, onOpen, onDelete, confirmDelete, onConfirm, onCancelDelete, onNew }) {
  return (
    <div className="pt-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-stone-500 mb-1" style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.3em' }}>
            SAVED REPORTS · {String(reports.length).padStart(3, '0')}
          </div>
          <h2 className="text-2xl text-stone-100" style={{ fontFamily: FONT_SANS, fontWeight: 300, letterSpacing: '-0.02em' }}>
            <span className="text-amber-400" style={{ fontWeight: 500 }}>Log</span>
          </h2>
        </div>
        <button
          onClick={onNew}
          className="p-3 border border-amber-400/40 bg-amber-400/5 text-amber-300 hover:bg-amber-400 hover:text-stone-950 transition-colors rounded-sm"
          aria-label="New report"
        >
          <Plus size={16} />
        </button>
      </div>

      {reports.length === 0 && (
        <div className="p-8 border border-stone-800 bg-stone-950 text-center rounded-sm">
          <Radio size={22} className="text-stone-700 mx-auto mb-3" />
          <div className="text-sm text-stone-500 mb-1" style={{ fontFamily: FONT_MONO }}>
            NO REPORTS LOGGED
          </div>
          <div className="text-xs text-stone-600">
            Saved reports persist on this device.
          </div>
        </div>
      )}

      <div className="space-y-2">
        {reports.map((r) => (
          <div key={r.id} className="border border-stone-800 bg-stone-950 rounded-sm overflow-hidden">
            <button
              onClick={() => onOpen(r)}
              className="w-full text-left p-3 hover:bg-stone-900 transition-colors flex items-center justify-between gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span
                    className="tracking-widest px-1.5 py-0.5 bg-amber-400/10 text-amber-300 border border-amber-400/20 rounded-sm"
                    style={{ fontFamily: FONT_MONO, fontWeight: 500, fontSize: '9px' }}
                  >
                    {r.templateCode}
                  </span>
                  {r.raw && (
                    <span
                      className="tracking-widest px-1.5 py-0.5 bg-stone-800 text-stone-400 rounded-sm"
                      style={{ fontFamily: FONT_MONO, fontWeight: 500, fontSize: '9px' }}
                    >
                      RAW
                    </span>
                  )}
                  {r.hasAudio && (
                    <span
                      className="tracking-widest px-1.5 py-0.5 bg-stone-800 text-stone-400 rounded-sm flex items-center gap-1"
                      style={{ fontFamily: FONT_MONO, fontWeight: 500, fontSize: '9px' }}
                    >
                      <Play size={7} /> AUDIO
                    </span>
                  )}
                  <span className="text-xs text-stone-400" style={{ fontFamily: FONT_MONO }}>
                    {r.items.length} ITEM{r.items.length !== 1 ? 'S' : ''}
                  </span>
                </div>
                <div className="text-stone-500 truncate" style={{ fontFamily: FONT_MONO, fontSize: '10px' }}>
                  {new Date(r.createdAt).toLocaleString()}
                </div>
              </div>
              <ChevronLeft size={14} className="text-stone-600 rotate-180 flex-shrink-0" />
            </button>
            {confirmDelete === r.id ? (
              <div className="flex border-t border-stone-800">
                <button
                  onClick={() => onConfirm(r.id)}
                  className="flex-1 py-3 text-red-400 hover:bg-red-950/30 transition-colors"
                  style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
                >
                  CONFIRM DELETE
                </button>
                <button
                  onClick={onCancelDelete}
                  className="flex-1 py-3 text-stone-400 hover:bg-stone-900 transition-colors border-l border-stone-800"
                  style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
                >
                  CANCEL
                </button>
              </div>
            ) : (
              <button
                onClick={() => onDelete(r.id)}
                className="w-full py-2 border-t border-stone-800 text-stone-700 hover:text-red-400 transition-colors"
                style={{ fontFamily: FONT_MONO, fontSize: '9px', letterSpacing: '0.2em' }}
              >
                DELETE
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Detail
// ═════════════════════════════════════════════════════════════
function DetailView({
  report, onCopy, onCSV, copied, onDelete, confirming, onConfirm, onCancelDelete,
  onBack, onRestructure, online,
}) {
  const template = TEMPLATES[report.template];
  const [audioURL, setAudioURL] = useState(null);

  useEffect(() => {
    let url;
    let cancelled = false;
    if (report.hasAudio) {
      kvGet('audio:' + report.id).then((blob) => {
        if (!(blob instanceof Blob)) return;
        url = URL.createObjectURL(blob);
        // The read can land after unmount, in which case cleanup already ran
        // with url still undefined and this one would never be revoked.
        if (cancelled) { URL.revokeObjectURL(url); return; }
        setAudioURL(url);
      });
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [report]);

  return (
    <div className="pt-6">
      <button
        onClick={onBack}
        className="text-stone-500 hover:text-amber-300 flex items-center gap-1 mb-5 py-2"
        style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
      >
        <ChevronLeft size={12} /> BACK TO LOG
      </button>

      <div className="mb-5">
        <div className="text-stone-500 mb-1" style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.3em' }}>
          {new Date(report.createdAt).toLocaleString()}
        </div>
        <h2 className="text-2xl text-stone-100" style={{ fontFamily: FONT_SANS, fontWeight: 300, letterSpacing: '-0.02em' }}>
          <span className="text-amber-400" style={{ fontWeight: 500 }}>{template.name}</span>
        </h2>
      </div>

      {audioURL && (
        <div className="mb-5 p-3 border border-stone-800 bg-stone-950 rounded-sm">
          <div className="text-stone-500 mb-2" style={{ fontFamily: FONT_MONO, fontSize: '9px', letterSpacing: '0.2em' }}>
            SOURCE AUDIO
          </div>
          <audio controls src={audioURL} className="w-full" style={{ height: '36px' }} />
        </div>
      )}

      <div className="space-y-3 mb-6">
        {report.items.length === 0 && (
          <div className="p-6 border border-stone-800 bg-stone-950 rounded-sm" style={{ fontFamily: FONT_MONO }}>
            <div className="text-sm text-stone-500 text-center mb-4">
              RAW CAPTURE — never structured. Transcript{report.hasAudio ? ' and audio are' : ' is'} below.
            </div>
            {report.transcript?.trim() && (
              <button
                onClick={onRestructure}
                disabled={!online}
                className="w-full px-6 py-3 bg-amber-400 hover:bg-amber-300 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 rounded-sm transition-colors"
                style={{ fontFamily: FONT_MONO, letterSpacing: '0.15em', fontWeight: 600, fontSize: '11px' }}
              >
                {online ? 'STRUCTURE IT NOW →' : 'NO SIGNAL — CANNOT STRUCTURE'}
              </button>
            )}
          </div>
        )}
        {report.items.map((item, idx) => (
          <div key={item._id || idx} className="border border-stone-800 bg-stone-950 p-3 rounded-sm">
            <div className="tracking-widest text-stone-600 mb-2" style={{ fontFamily: FONT_MONO, fontSize: '10px' }}>
              [{String(idx + 1).padStart(2, '0')}]
            </div>
            <div className="space-y-1.5">
              {template.fields.map((field) => (
                <div key={field} className="flex gap-2 text-sm">
                  <span
                    className="tracking-widest text-stone-500 pt-0.5 w-16 flex-shrink-0"
                    style={{ fontFamily: FONT_MONO, fontSize: '9px' }}
                  >
                    {field.toUpperCase()}
                  </span>
                  <span
                    className="text-stone-200 flex-1"
                    style={{ fontFamily: field === 'tag' || field === 'type' ? FONT_MONO : FONT_SANS }}
                  >
                    {item[field] || <span className="text-stone-600">—</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {report.transcript && (
        <details className="mb-6 border border-stone-800 bg-stone-950 rounded-sm">
          <summary
            className="px-3 py-3 text-stone-500 cursor-pointer hover:text-amber-300"
            style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
          >
            ▸ ORIGINAL TRANSCRIPT
          </summary>
          <div className="px-3 pb-3 text-xs text-stone-400 leading-relaxed" style={{ fontFamily: FONT_MONO }}>
            {report.transcript}
          </div>
          {report.items.length > 0 && (
            <div className="px-3 pb-3">
              <button
                onClick={onRestructure}
                disabled={!online}
                className="text-stone-500 hover:text-amber-300 disabled:text-stone-700 transition-colors py-2"
                style={{ fontFamily: FONT_MONO, fontSize: '10px', letterSpacing: '0.2em' }}
              >
                ↻ RE-STRUCTURE FROM THIS TRANSCRIPT
              </button>
            </div>
          )}
        </details>
      )}

      {confirming ? (
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-4 border border-red-500/50 bg-red-950/30 text-red-400 rounded-sm"
            style={{ fontFamily: FONT_MONO, fontSize: '11px', letterSpacing: '0.1em' }}
          >
            CONFIRM DELETE
          </button>
          <button
            onClick={onCancelDelete}
            className="flex-1 px-4 py-4 border border-stone-700 text-stone-300 rounded-sm"
            style={{ fontFamily: FONT_MONO, fontSize: '11px', letterSpacing: '0.1em' }}
          >
            CANCEL
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={onCopy}
            className="flex-1 px-3 py-4 border border-stone-700 hover:border-amber-400/60 text-stone-200 flex items-center justify-center gap-2 transition-colors rounded-sm bg-stone-950"
            style={{ fontFamily: FONT_MONO, fontWeight: 500, letterSpacing: '0.1em', fontSize: '11px' }}
          >
            {copied ? <><Check size={14} /> COPIED</> : <><Copy size={14} /> COPY</>}
          </button>
          <button
            onClick={onCSV}
            className="px-4 py-4 border border-stone-700 hover:border-amber-400/60 text-stone-300 transition-colors rounded-sm bg-stone-950"
            aria-label="Export CSV"
          >
            <Download size={14} />
          </button>
          <button
            onClick={onDelete}
            className="px-4 py-4 border border-stone-700 hover:border-red-500/60 text-stone-400 hover:text-red-400 transition-colors rounded-sm bg-stone-950"
            aria-label="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Footer
// ═════════════════════════════════════════════════════════════
function Footer({ online }) {
  return (
    <footer className="fr-app-footer pt-3 border-t border-stone-900 flex items-center justify-between">
      <span className="text-stone-700" style={{ fontFamily: FONT_MONO, fontSize: '9px', letterSpacing: '0.25em' }}>
        v0.3 · CAPTURE OFFLINE · STRUCTURE ONLINE
      </span>
      <span
        style={{
          fontFamily: FONT_MONO, fontSize: '9px', letterSpacing: '0.25em',
          color: online ? '#57534e' : '#f59e0b',
        }}
      >
        {online ? 'LINK OK' : 'NO LINK'}
      </span>
    </footer>
  );
}

/* The proxy that backs STRUCTURE_ENDPOINT lives in
   supabase/functions/structure-report/index.ts — that file is the source of
   truth for the prompts, CORS, and rate limiting. A second copy used to sit
   here in a comment, and had already drifted from the deployed one. */
