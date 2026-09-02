import { test, expect } from '@playwright/test';

/**
 * The structure-later path, end to end.
 *
 * This is the flow v0.3 added and the one with the most ways to go quietly
 * wrong: a saved report is pulled back into the record screen, structured, and
 * saved — and that save must REPLACE the original entry rather than log a
 * second copy of one walkdown.
 *
 * The structuring endpoint is mocked in both directions, so the suite needs no
 * network and no API key. That is deliberate: the real endpoint currently
 * answers 500 (see DEFECTS.md), and a test that depends on someone's Anthropic
 * spend is a test people stop running.
 *
 * What this cannot cover: anything needing a real microphone — speech
 * recognition, the interim flush on stop, the wake lock. Those stay device
 * checks, listed in README under "Not verified".
 */

const ENDPOINT = 'https://itxcaamyiilvotfzctit.supabase.co/functions/v1/structure-report';

const TRANSCRIPT =
  'level transmitter two hundred at the reactor sump reads high no comms on ' +
  'the pressure transmitter three ten check valve at the exchanger is weeping ' +
  'needs a gasket';

const SEED_ID = 'r_seed001';
const SEED_CREATED = '2026-08-30T13:05:00.000Z';

// Shaped like a real Anthropic messages response: the JSON the model returns
// is a string inside a text block, which is what the client has to dig out.
const MODEL_REPLY = {
  stop_reason: 'end_turn',
  content: [{
    type: 'text',
    text: JSON.stringify({
      items: [
        { tag: 'LT-200', type: 'LEVEL', status: 'FAIL', notes: 'reactor sump reads high' },
        // lowercase enum — must be normalised
        { tag: 'PT-310', type: 'PRESS', status: 'fail', notes: 'no comms' },
        // malformed tag and missing enum — must be flagged, not silently kept
        { tag: 'CHK VALVE!!', type: '', status: '', notes: 'weeping at the exchanger, needs a gasket' },
      ],
    }),
  }],
};

/** Seed one RAW capture directly in the shape the app stores. */
async function seedRawReport(page) {
  await page.evaluate(async ({ transcript, id, createdAt }) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('field-report', 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const reports = [{
      id,
      template: 'loop',
      templateName: 'LOOP CHECK',
      templateCode: 'LOOP',
      createdAt,
      items: [],
      transcript,
      hasAudio: false,
      raw: true,
    }];
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite').objectStore('kv').put(reports, 'reports');
      t.onsuccess = res;
      t.onerror = () => rej(t.error);
    });
  }, { transcript: TRANSCRIPT, id: SEED_ID, createdAt: SEED_CREATED });
}

/** Read the log back out of IndexedDB — the assertion that matters most. */
const readReports = (page) => page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('field-report', 1);
    r.onsuccess = () => res(r.result);
  });
  return await new Promise((res) => {
    const t = db.transaction('kv', 'readonly').objectStore('kv').get('reports');
    t.onsuccess = () => res(t.result);
  });
});

const openSeededReport = async (page) => {
  await page.getByText('LOOP', { exact: true }).first().click();
  await expect(page.getByRole('button', { name: /BACK TO LOG/ })).toBeVisible();
};

test('a raw capture can be structured later, and replaces itself in the log', async ({ page }) => {
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // The mocked 500 legitimately logs a failed resource load.
    if (m.type() === 'error' && !/status of 500/.test(m.text())) consoleErrors.push(m.text());
  });

  await page.goto('/');
  await seedRawReport(page);
  await page.reload();

  await test.step('the log lists the raw capture', async () => {
    await expect(page.getByText('What are you')).toBeVisible();
    await page.getByRole('button', { name: /LOG · 001/ }).click();
    await expect(page.getByText('RAW', { exact: true }).first()).toBeVisible();
  });

  await test.step('COPY on a raw capture yields the transcript, not a bare header', async () => {
    await openSeededReport(page);
    await page.getByRole('button', { name: /^COPY$/ }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('RAW CAPTURE — not structured');
    expect(clip).toContain('level transmitter two hundred');
  });

  await test.step('STRUCTURE IT NOW carries the transcript into the record screen', async () => {
    await page.getByRole('button', { name: /STRUCTURE IT NOW/ }).click();
    await expect(page.getByText('STRUCTURING A SAVED REPORT.')).toBeVisible();
    await expect(page.getByText(/level transmitter two hundred/)).toBeVisible();
    // SAVE RAW would be a lie here — it replaces, it does not add.
    await expect(page.getByRole('button', { name: /LEAVE AS RAW/ })).toBeVisible();
  });

  await test.step('a proxy error is translated into something actionable', async () => {
    await page.route(ENDPOINT, (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: 'server_misconfigured' }),
    }));

    await page.getByRole('button', { name: /GENERATE REPORT/ }).click();
    await expect(page.getByText(/has no API key set yet/)).toBeVisible();
    // The raw code must not reach the field.
    await expect(page.getByText('server_misconfigured')).toHaveCount(0);
  });

  await test.step('LEAVE AS RAW replaces the entry instead of adding one', async () => {
    await page.getByRole('button', { name: /LEAVE AS RAW/ }).click();
    await expect(page.getByRole('button', { name: /LOG · 001/ })).toBeVisible();

    const [report, ...rest] = await readReports(page);
    expect(rest).toHaveLength(0);
    expect(report.id).toBe(SEED_ID);
    expect(report.createdAt).toBe(SEED_CREATED);
    expect(report.raw).toBe(true);
    // No recording happened, so nothing may have been attached.
    expect(report.hasAudio).toBe(false);
  });

  await test.step('a successful structure lands in review, coerced and flagged', async () => {
    await page.unroute(ENDPOINT);
    await page.route(ENDPOINT, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(MODEL_REPLY),
    }));

    await openSeededReport(page);
    await page.getByRole('button', { name: /STRUCTURE IT NOW/ }).click();
    await page.getByRole('button', { name: /GENERATE REPORT/ }).click();

    await expect(page.getByText(/STEP 03 \/ REVIEW · 3 ITEMS/)).toBeVisible();
    await expect(page.getByText('⚑ CHECK TAG')).toHaveCount(1);
    await expect(page.getByText(/1 tag did not match/)).toBeVisible();

    // coerceItems: lowercase normalised, missing value defaulted — never blank.
    const statuses = await page.locator('select').evaluateAll((els) => els.map((e) => e.value));
    expect(statuses).toEqual(['FAIL', 'FAIL', 'PEND']);
  });

  await test.step('SAVE TO LOG replaces the original entry', async () => {
    await page.getByRole('button', { name: /SAVE TO LOG/ }).click();
    await expect(page.getByRole('button', { name: /LOG · 001/ })).toBeVisible();

    const [report, ...rest] = await readReports(page);
    expect(rest).toHaveLength(0);                 // not a second copy
    expect(report.id).toBe(SEED_ID);              // same entry
    expect(report.createdAt).toBe(SEED_CREATED);  // original walkdown time
    expect(report.items).toHaveLength(3);
    expect(report.raw).toBe(false);               // no longer a raw capture
    expect(report.structuredAt).toBeTruthy();
    expect(report.hasAudio).toBe(false);          // no stray audio attached
    expect(report.transcript).toContain('level transmitter two hundred');
  });

  expect(consoleErrors).toEqual([]);
});
