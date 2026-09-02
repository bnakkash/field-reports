import { test, expect } from '@playwright/test';

/**
 * Silent mode and the edge-swipe back gesture.
 *
 * Silent mode exists because the app cannot silence iOS: every start and stop
 * of SpeechRecognition plays the system dictation chime, and Safari restarts
 * recognition throughout a long dictation. The only lever a web page has is not
 * to run the recognizer — so the thing worth asserting is that silent mode
 * genuinely never constructs one.
 *
 * The swipe is deliberately edge-anchored, so the negative cases (a swipe that
 * starts mid-screen, one that is too short, one that is mostly vertical) matter
 * as much as the positive one: a gesture that fires by accident while someone
 * is selecting transcript text is worse than no gesture.
 */

/** Count SpeechRecognition constructions, before any app code runs. */
async function countRecognizers(page) {
  await page.addInitScript(() => {
    window.__srStarts = 0;
    const Real = window.SpeechRecognition || window.webkitSpeechRecognition;
    class Counted {
      constructor() { window.__srStarts += 1; if (Real) return new Real(); }
      start() {} stop() {} abort() {}
      addEventListener() {} removeEventListener() {}
    }
    window.SpeechRecognition = Counted;
    window.webkitSpeechRecognition = Counted;
  });
}

/** Synthesise a touch drag. Playwright's touchscreen only taps. */
async function swipe(page, fromX, toX, y = 400, dy = 0) {
  await page.evaluate(({ fromX, toX, y, dy }) => {
    const el = document.querySelector('.fr-app-shell');
    const touch = (x, ty) => new Touch({ identifier: 1, target: el, clientX: x, clientY: ty });
    el.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true,
      touches: [touch(fromX, y)], targetTouches: [touch(fromX, y)], changedTouches: [touch(fromX, y)],
    }));
    el.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true,
      touches: [], targetTouches: [], changedTouches: [touch(toX, y + dy)],
    }));
  }, { fromX, toX, y, dy });
}

async function seedReport(page) {
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('field-report', 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite').objectStore('kv').put([{
        id: 'r_ux001', template: 'loop', templateName: 'LOOP CHECK', templateCode: 'LOOP',
        createdAt: '2026-09-02T08:00:00.000Z', items: [],
        transcript: 'pressure transmitter three ten no comms',
        hasAudio: false, raw: true,
      }], 'reports');
      t.onsuccess = res; t.onerror = () => rej(t.error);
    });
  });
  await page.reload();
}

test('silent mode never constructs a recognizer, and persists across launches', async ({ page }) => {
  await countRecognizers(page);
  await page.goto('/');

  await page.getByRole('button', { name: /LOOP CHECK/ }).click();
  await expect(page.getByRole('button', { name: /LIVE/ })).toBeVisible();

  await test.step('switching to silent swaps the transcript for a typeable field', async () => {
    await page.getByRole('button', { name: /LIVE/ }).click();
    await expect(page.getByRole('button', { name: /SILENT/ })).toBeVisible();
    await expect(page.getByText('SILENT — NO LIVE TRANSCRIPTION.')).toBeVisible();
    // The whole point: there is no live transcript, so you type instead.
    await expect(page.getByLabel('Transcript')).toBeVisible();
  });

  await test.step('typed notes drive the normal structuring path', async () => {
    await page.getByLabel('Transcript').fill('pressure transmitter three ten no comms');
    await expect(page.getByRole('button', { name: /GENERATE REPORT/ })).toBeEnabled();
    // Typing is not speech recognition — nothing should have been constructed.
    expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  });

  await test.step('the preference survives a relaunch', async () => {
    await page.reload();
    await page.getByRole('button', { name: /LOOP CHECK/ }).click();
    await expect(page.getByRole('button', { name: /SILENT/ })).toBeVisible();
    expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  });
});

test('an edge swipe goes back, and other gestures do not', async ({ page }) => {
  await page.goto('/');
  await seedReport(page);

  await test.step('detail → history', async () => {
    await page.getByRole('button', { name: /LOG · 001/ }).click();
    await page.getByText('LOOP', { exact: true }).first().click();
    await expect(page.getByRole('button', { name: /BACK TO LOG/ })).toBeVisible();

    await swipe(page, 8, 200);
    await expect(page.getByText(/SAVED REPORTS · 001/)).toBeVisible();
  });

  await test.step('history → home', async () => {
    await swipe(page, 8, 200);
    await expect(page.getByText('What are you')).toBeVisible();
  });

  await test.step('a swipe starting mid-screen is ignored', async () => {
    await page.getByRole('button', { name: /LOG · 001/ }).click();
    await expect(page.getByText(/SAVED REPORTS · 001/)).toBeVisible();

    await swipe(page, 200, 380);
    // Still on the log — selecting text or scrolling must never navigate.
    await expect(page.getByText(/SAVED REPORTS · 001/)).toBeVisible();
  });

  await test.step('a too-short swipe is ignored', async () => {
    await swipe(page, 8, 40);
    await expect(page.getByText(/SAVED REPORTS · 001/)).toBeVisible();
  });

  await test.step('a mostly-vertical drag is ignored', async () => {
    await swipe(page, 8, 120, 300, 200);
    await expect(page.getByText(/SAVED REPORTS · 001/)).toBeVisible();
  });
});
