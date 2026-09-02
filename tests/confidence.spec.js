import { test, expect } from '@playwright/test';

/**
 * Confidence scores and alternative readings.
 *
 * The fixture below is real: it is what iOS 18.7 actually returned during a
 * walkdown dictation, copied out of public/diag.html. That matters, because the
 * whole feature rests on two empirical claims this data is the evidence for —
 * WebKit does populate `confidence`, and the correct reading of a misheard unit
 * tag really does turn up in the alternatives list.
 *
 * "LA 90 Ios" at 0.38 is the phrase the phone got wrong; "LA 90 iso" is sitting
 * in its alternatives. Repairing that by tapping, rather than retyping a tag on
 * a phone at a piece of equipment, is the point.
 */

// Verbatim from the device report.
const HEARD = [
  { conf: 0.968, alts: ['Tank 531 a level reading tank empty showing remove mixers for repair pond number 23 and six'] },
  { conf: 0.896, alts: [
      '855 vacuum issues P602 Band-Aid discharge leak',
      'A 55 vacuum issues P602 Band-Aid discharge leak',
      '855 vacuum issues piece 602 Band-Aid discharge leak',
  ] },
  { conf: 0.383, alts: ['LA 90 Ios', 'La 90 Ios', 'LA 90 iso'] },
  { conf: 0.953, alts: [
      'Pick up reels at 300 a and B 900 CFT101EF not reading rework conduit SOV 955',
      'Pick up reels at 300 and B 900 CFT101EF not reading rework conduit SOV 955',
  ] },
];

/** Replace SpeechRecognition with something we can drive, before app code runs. */
async function stubRecognition(page) {
  await page.addInitScript(() => {
    class FakeRecognition {
      constructor() {
        this.continuous = false;
        this.interimResults = false;
        this.maxAlternatives = 1;
        this.lang = 'en-US';
      }
      start() {
        window.__sr = this;
        window.__maxAlternatives = this.maxAlternatives;
        setTimeout(() => this.onstart && this.onstart(), 0);
      }
      stop() { setTimeout(() => this.onend && this.onend(), 0); }
      abort() {}
      addEventListener() {}
      removeEventListener() {}
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;

    // Shape matches a real SpeechRecognitionEvent closely enough for the
    // handler: indexable results, each indexable by alternative.
    window.__hear = (phrases) => {
      const results = phrases.map((p) => {
        const r = { isFinal: true, length: p.alts.length };
        p.alts.forEach((t, i) => { r[i] = { transcript: t, confidence: i === 0 ? p.conf : p.conf * 0.9 }; });
        return r;
      });
      window.__sr.onresult({ resultIndex: 0, results });
    };
  });
}

test('a low-confidence phrase is flagged and repairable from the alternatives', async ({ page }) => {
  await stubRecognition(page);
  await page.goto('/');

  await page.getByRole('button', { name: /LOOP CHECK/ }).click();
  await expect(page.getByRole('button', { name: /LIVE/ })).toBeVisible();

  await test.step('the app asks the engine for more than one guess', async () => {
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText(/^REC ·/)).toBeVisible();
    // Default is 1; without raising it there are no alternatives to offer.
    expect(await page.evaluate(() => window.__maxAlternatives)).toBe(5);
  });

  await test.step('recognised phrases become the transcript', async () => {
    await page.evaluate((h) => window.__hear(h), HEARD);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByText(/Tank 531 a level reading/)).toBeVisible();
  });

  await test.step('only phrases below the threshold are called out', async () => {
    // 0.383 and 0.896 fall under 0.9; 0.953 and 0.968 do not. The 0.896 phrase
    // is "855 vacuum issues", where the correct reading — "A 55" — is sitting
    // in its alternatives, so catching it is the point of the threshold.
    await expect(page.getByText(/2 PHRASES THE PHONE WAS UNSURE OF/)).toBeVisible();
  });

  await test.step('tapping it shows what else the phone heard', async () => {
    await page.getByRole('button', { name: /LA 90 Ios — low confidence/ }).click();
    await expect(page.getByText(/PHONE WAS 38% SURE · 3 READINGS/)).toBeVisible();
    await expect(page.getByRole('button', { name: /LA 90 iso/ })).toBeVisible();
  });

  await test.step('choosing one rewrites the transcript', async () => {
    await page.getByRole('button', { name: /○ LA 90 iso/ }).click();
    await expect(page.getByText(/LA 90 iso/)).toBeVisible();
    // A repaired phrase stops counting, so the banner tracks what is left.
    await expect(page.getByText(/1 PHRASE THE PHONE WAS UNSURE OF/)).toBeVisible();

    // The repair must reach the text that actually gets structured, not just
    // the rendering — the model only ever sees the transcript.
    const sent = [];
    await page.route('**/functions/v1/structure-report', (route) => {
      sent.push(JSON.parse(route.request().postData() || '{}').transcript);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ content: [{ type: 'text', text: '{"items":[]}' }] }),
      });
    });
    await page.getByRole('button', { name: /GENERATE REPORT/ }).click();
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).toContain('LA 90 iso');
    expect(sent[0]).not.toContain('LA 90 Ios');
    // The phrases around it survive the rebuild untouched.
    expect(sent[0]).toContain('Tank 531 a level reading');
    expect(sent[0]).toContain('Pick up reels at 300');
  });
});
