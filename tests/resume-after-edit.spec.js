import { test, expect } from '@playwright/test';

/**
 * Dictating again after fixing a misheard word.
 *
 * A hand-edit sets `chunksStale`, which permanently detaches the transcript
 * from the recognised chunks — that is deliberate, because the edited text no
 * longer corresponds to what the engine returned. What was not deliberate is
 * what happened on the next press of record: finals kept landing in `chunks`,
 * the derivation stayed switched off, and every word spoken after the edit was
 * dropped from the transcript, the draft, and the saved report. Only the
 * interim text flashed on screen, so it looked like nothing was being heard.
 *
 * Repairing a misheard tag and then carrying on down the line is the ordinary
 * shape of a walkdown, so this path has to hold.
 */

/** Same driveable stand-in for SpeechRecognition as confidence.spec.js. */
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
        setTimeout(() => this.onstart && this.onstart(), 0);
      }
      stop() { setTimeout(() => this.onend && this.onend(), 0); }
      abort() {}
      addEventListener() {}
      removeEventListener() {}
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;

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

const FIRST = [{ conf: 0.9, alts: ['855 vacuum issues P602 discharge leak'] }];
const SECOND = [{ conf: 0.96, alts: ['LT-200 level reading normal'] }];

test('speech after a hand-edit still reaches the transcript and the report', async ({ page }) => {
  await stubRecognition(page);
  await page.goto('/');

  await page.getByRole('button', { name: /LOOP CHECK/ }).click();
  await expect(page.getByRole('button', { name: /LIVE/ })).toBeVisible();

  await test.step('dictate, then repair a misheard tag by hand', async () => {
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText(/^REC ·/)).toBeVisible();
    await page.evaluate((h) => window.__hear(h), FIRST);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByText(/855 vacuum issues/)).toBeVisible();

    await page.getByRole('button', { name: /FIX MISHEARD WORDS/ }).click();
    const box = page.getByLabel('Transcript');
    await box.fill('A-55 vacuum issues P602 discharge leak');
    await expect(box).toHaveValue(/A-55 vacuum issues/);
  });

  await test.step('recording again puts the repaired text back in front of you', async () => {
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText(/^REC ·/)).toBeVisible();
    // The free-text box must give way — otherwise the next phrase appears to
    // land in something the user is still typing into.
    await expect(page.getByLabel('Transcript')).toHaveCount(0);
    await expect(page.getByText(/A-55 vacuum issues/)).toBeVisible();
  });

  await test.step('and what is said next appends to it instead of vanishing', async () => {
    await page.evaluate((h) => window.__hear(h), SECOND);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByText(/LT-200 level reading normal/)).toBeVisible();
    // The repair is not undone by the resume.
    await expect(page.getByText(/A-55 vacuum issues/)).toBeVisible();
    await expect(page.getByText(/855 vacuum issues/)).toHaveCount(0);
  });

  await test.step('both halves reach the model, which is the text that matters', async () => {
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
    expect(sent[0]).toContain('A-55 vacuum issues');
    expect(sent[0]).toContain('LT-200 level reading normal');
    expect(sent[0]).not.toContain('855 vacuum issues');
  });
});
