import { test, expect } from '@playwright/test';

/**
 * The passphrase gate.
 *
 * The proxy's shared secret must never ship in the bundle, so the app asks for
 * it once per device and keeps it in that device's storage. The prompt is
 * lazy — driven entirely by a 401 from the proxy — which is what lets the same
 * build work whether or not FR_SHARED_SECRET is set on the function, with no
 * flag or rebuild to keep in sync.
 *
 * These tests drive the proxy's three answers in sequence: 401 (locked),
 * 200 (correct passphrase), and 401 again (secret rotated).
 */

const ENDPOINT = 'https://itxcaamyiilvotfzctit.supabase.co/functions/v1/structure-report';
const PASSPHRASE = 'correct-horse-battery-staple';

const MODEL_REPLY = {
  stop_reason: 'end_turn',
  content: [{
    type: 'text',
    text: JSON.stringify({
      items: [{ tag: 'LT-200', type: 'LEVEL', status: 'PASS', notes: 'sump reads normal' }],
    }),
  }],
};

/** Route the endpoint, recording every x-fr-key header the client sends. */
async function routeProxy(page, sentKeys, respond) {
  await page.unroute(ENDPOINT).catch(() => {});
  await page.route(ENDPOINT, (route) => {
    sentKeys.push(route.request().headers()['x-fr-key'] ?? null);
    respond(route);
  });
}

const unauthorized = (route) => route.fulfill({
  status: 401,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({ error: 'unauthorized' }),
});

const ok = (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(MODEL_REPLY),
});

async function seedAndOpen(page) {
  await page.goto('/');
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
        id: 'r_pass001', template: 'loop', templateName: 'LOOP CHECK', templateCode: 'LOOP',
        createdAt: '2026-09-02T08:00:00.000Z', items: [],
        transcript: 'level transmitter two hundred at the sump reads normal',
        hasAudio: false, raw: true,
      }], 'reports');
      t.onsuccess = res; t.onerror = () => rej(t.error);
    });
  });
  await page.reload();
  await page.getByRole('button', { name: /LOG · 001/ }).click();
  await page.getByText('LOOP', { exact: true }).first().click();
  await page.getByRole('button', { name: /STRUCTURE IT NOW/ }).click();
  await expect(page.getByText('STRUCTURING A SAVED REPORT.')).toBeVisible();
}

/** What the app has cached for this device. */
const storedPassphrase = (page) => page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('field-report', 1); r.onsuccess = () => res(r.result);
  });
  return await new Promise((res) => {
    const t = db.transaction('kv', 'readonly').objectStore('kv').get('passphrase');
    t.onsuccess = () => res(t.result ?? null);
  });
});

test('the passphrase is asked for on 401, stored, and re-asked when rotated', async ({ page }) => {
  const sentKeys = [];
  await seedAndOpen(page);

  await test.step('a locked proxy raises the gate instead of an error', async () => {
    await routeProxy(page, sentKeys, unauthorized);
    await page.getByRole('button', { name: /GENERATE REPORT/ }).click();

    await expect(page.getByText('PASSPHRASE REQUIRED')).toBeVisible();
    // A 401 is a prompt, not a failure — no red error box.
    await expect(page.getByText(/Server 401|unauthorized/)).toHaveCount(0);
    // First attempt legitimately carries no key.
    expect(sentKeys).toEqual([null]);
  });

  await test.step('the entered passphrase is sent and the request retried', async () => {
    await routeProxy(page, sentKeys, ok);
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.getByRole('button', { name: 'UNLOCK' }).click();

    await expect(page.getByText(/STEP 03 \/ REVIEW/)).toBeVisible();
    expect(sentKeys[sentKeys.length - 1]).toBe(PASSPHRASE);
    await expect(page.getByText('PASSPHRASE REQUIRED')).toHaveCount(0);
  });

  await test.step('it persists on the device, so it is asked once and not again', async () => {
    expect(await storedPassphrase(page)).toBe(PASSPHRASE);

    await page.reload();
    await page.getByRole('button', { name: /LOG · 001/ }).click();
    await page.getByText('LOOP', { exact: true }).first().click();
    await page.getByRole('button', { name: /STRUCTURE IT NOW/ }).click();
    await page.getByRole('button', { name: /GENERATE REPORT/ }).click();

    await expect(page.getByText(/STEP 03 \/ REVIEW/)).toBeVisible();
    await expect(page.getByText('PASSPHRASE REQUIRED')).toHaveCount(0);
    expect(sentKeys[sentKeys.length - 1]).toBe(PASSPHRASE);
  });

  await test.step('a rotated secret clears the stale value rather than wedging', async () => {
    await page.getByRole('button', { name: /BACK TO TRANSCRIPT/ }).click();
    await routeProxy(page, sentKeys, unauthorized);
    await page.getByRole('button', { name: /GENERATE REPORT/ }).click();

    await expect(page.getByText('PASSPHRASE REQUIRED')).toBeVisible();
    // The bad value must not stay cached, or every future attempt fails silently.
    expect(await storedPassphrase(page)).toBeNull();
  });
});

test('no passphrase is sent, or asked for, when the proxy has no secret', async ({ page }) => {
  const sentKeys = [];
  await seedAndOpen(page);
  await routeProxy(page, sentKeys, ok);

  await page.getByRole('button', { name: /GENERATE REPORT/ }).click();
  await expect(page.getByText(/STEP 03 \/ REVIEW/)).toBeVisible();

  // The same build must work against an unsecured function with no prompt —
  // that is what makes the client and server independent.
  await expect(page.getByText('PASSPHRASE REQUIRED')).toHaveCount(0);
  expect(sentKeys).toEqual([null]);
  expect(await storedPassphrase(page)).toBeNull();
});

test('the bundle contains no shared secret', async ({ page }) => {
  await page.goto('/');
  const src = await page.evaluate(async () => {
    const tag = [...document.querySelectorAll('script[src]')].map((s) => s.src)[0];
    return tag ? await (await fetch(tag)).text() : '';
  });
  expect(src.length).toBeGreaterThan(1000);
  // The whole point of the feature: nothing key-shaped is compiled in.
  expect(src).not.toContain('VITE_FR_KEY');
  expect(src).not.toContain('sk-ant');
});
