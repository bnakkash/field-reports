/**
 * Vocabulary regression check — run by hand, not part of `npm test`.
 *
 *   npm run check:vocab
 *
 * The plant vocabulary lives in the Edge Function's system prompt, so the only
 * honest way to test it is against the deployed function with a real model
 * call. That costs roughly five cents and is not perfectly deterministic, which
 * is why it sits outside the suite: `npm test` must stay free, offline and
 * repeatable.
 *
 * Run this after any edit to PLANT_VOCAB, and after changing ANTHROPIC_MODEL.
 *
 * The fixture is a real walkdown dictation captured on an iPhone, so the
 * failures it pins are ones that actually happened rather than ones imagined.
 *
 * Checks come in two kinds, because a model call is not a pure function:
 *
 *   REQUIRED — the vocabulary either works or it doesn't. Most are negative:
 *     recognise units that WERE said without inventing ones that were not. A
 *     fabricated location in a maintenance record is worse than a number left
 *     as it was heard. These must pass every run; a failure is a real defect.
 *
 *   ADVISORY — outcomes that depend on the model's judgement rather than the
 *     vocabulary. "LA 90 Ios" is a garbled fragment with no observation and no
 *     action attached; whether it becomes a row at all is a reasonable call
 *     either way, and it varies between runs. Reported, never fatal.
 */

const ENDPOINT =
  process.env.VITE_STRUCTURE_ENDPOINT ||
  'https://itxcaamyiilvotfzctit.supabase.co/functions/v1/structure-report';

const TRANSCRIPT = [
  'Tank 531 a level reading tank empty showing remove mixers for repair pond number 23 and six',
  '855 vacuum issues P602 Band-Aid discharge leak',
  'LA 90 Ios',
  'Pick up reels at 300 a and B 900 CFT101EF not reading rework conduit SOV 955',
  'M590 steam tracer leak near drop pot PCV 5520 leaking by TT 51 a 50 bottoms '
    + 'temperature transmitter verify TE105 on 810',
].join(' ');

const REQUIRED = [
  // Positive: a swallowed leading "A" restored. This is the whole point.
  ['"855" is read as A55',                    (s) => /\bA55\b/.test(s)],
  ['"810" is read as A10',                    (s) => /\bA10\b/.test(s)],
  ['"M590" survives unchanged',               (s) => /\bM590\b/.test(s)],

  // Negative: numbers that look like units but are not. Every one of these was
  // observed being fabricated by an earlier version of the prompt.
  ['SOV-955 does not become A95',             (s) => /SOV/.test(s) && !/\bA95\b/.test(s)],
  ['PCV-5520 does not become M552',           (s) => /PCV/.test(s) && !/\bM552\b/.test(s)],
  ['"reels at 300 a" does not become M300A',  (s) => !/\bM300A\b/.test(s)],
  ['"TT 51 a 50" does not emit A50',          (s) => !/\bA50\b/.test(s)],
  ['Tank 531 stays a tank',                   (s) => /Tank\s*531/i.test(s)],
  ['P602 stays a pump',                       (s) => /P-?\s?602/.test(s)],
];

const ADVISORY = [
  // Only meaningful if the fragment survives at all, which is the model's call.
  ['"LA 90" is read as A90 (when kept)',      (s) => /\bA90\b/.test(s)],
];

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    Origin: 'https://bnakkash.github.io',
    ...(process.env.FR_KEY ? { 'x-fr-key': process.env.FR_KEY } : {}),
  },
  body: JSON.stringify({ template: 'punch', transcript: TRANSCRIPT }),
});

if (!res.ok) {
  console.error(`endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  console.error('(a 401 means FR_SHARED_SECRET is set — pass FR_KEY=… to this script)');
  process.exitCode = 1;
} else {
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = text.replace(/^```(?:json)?/, '').replace(/```$/, '').trim();

  let items = null;
  try {
    items = JSON.parse(json).items;
  } catch {
    console.error('could not parse model output as JSON:\n' + json.slice(0, 400));
    process.exitCode = 1;
  }

  if (items) {
    const blob = JSON.stringify(items);
    console.log(`${items.length} items, ${data.usage.input_tokens}/${data.usage.output_tokens} tokens\n`);
    for (const it of items) console.log('  ' + (it.location || '—').padEnd(16) + ' | ' + it.item);

    let failed = 0;
    console.log('\nREQUIRED');
    for (const [name, fn] of REQUIRED) {
      const ok = fn(blob);
      if (!ok) failed++;
      console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
    }

    console.log('\nADVISORY  (judgement, not vocabulary — never fatal)');
    for (const [name, fn] of ADVISORY) {
      console.log((fn(blob) ? '  ok    ' : '  miss  ') + name);
    }

    console.log(`\n${REQUIRED.length - failed}/${REQUIRED.length} required checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
}
