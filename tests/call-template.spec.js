import { test, expect } from '@playwright/test';

/**
 * The CALL NOTES template.
 *
 * A call is not a walkdown: the record is who owes what, so the interesting
 * field is `owner`, and the interesting failure is a model returning something
 * outside the enum. coerceItems has to pull that back to the default rather
 * than render a blank select — a commitment row with no owner is worse than
 * useless in a record of who promised what.
 */

const ENDPOINT = 'https://itxcaamyiilvotfzctit.supabase.co/functions/v1/structure-report';

const MODEL_REPLY = {
  stop_reason: 'end_turn',
  content: [{
    type: 'text',
    text: JSON.stringify({
      items: [
        { who: 'Mike', topic: 'Seal kit lead time', action: 'Checking other distributor', owner: 'THEM' },
        // lowercase — must normalise
        { who: 'Mike', topic: 'Flush plan datasheet', action: 'Email it this afternoon', owner: 'me' },
        // outside the enum entirely — must fall back to the default, not blank
        { who: '', topic: 'Rep change', action: 'Dave retiring, Carlos taking over', owner: 'FYI' },
      ],
    }),
  }],
};

test('CALL NOTES is offered, and owner values are coerced into the enum', async ({ page }) => {
  await page.route(ENDPOINT, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(MODEL_REPLY),
  }));

  await page.goto('/');

  await test.step('it appears alongside the walkdown templates', async () => {
    await expect(page.getByRole('button', { name: /PUNCH LIST/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /LOOP CHECK/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /FIELD NOTES/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /CALL NOTES/ })).toBeVisible();
  });

  await test.step('a call transcript structures into owned rows', async () => {
    await page.getByRole('button', { name: /CALL NOTES/ }).click();
    // Silent mode keeps this deterministic — no recognizer, just typed text.
    await page.getByRole('button', { name: /LIVE/ }).click();
    await page.getByLabel('Transcript').fill(
      'Mike is checking the other distributor on seal kit lead time and calling back Wednesday. ' +
      'I owe him the flush plan datasheet. Their rep Dave is retiring, Carlos is taking over.'
    );
    await page.getByRole('button', { name: /GENERATE REPORT/ }).click();
    await expect(page.getByText(/STEP 03 \/ REVIEW · 3 ITEMS/)).toBeVisible();
  });

  await test.step('owner is normalised, and an out-of-enum value falls back', async () => {
    const owners = await page.locator('select').evaluateAll((els) => els.map((e) => e.value));
    // 'me' uppercased; 'FYI' is not a valid owner and must become the default.
    expect(owners).toEqual(['THEM', 'ME', 'NONE']);
    // Every row keeps an owner — none may render empty.
    expect(owners.every(Boolean)).toBe(true);
  });

  await test.step('it saves to the log under its own code', async () => {
    await page.getByRole('button', { name: /SAVE TO LOG/ }).click();
    await expect(page.getByRole('button', { name: /LOG · 001/ })).toBeVisible();
    await expect(page.getByText('CALL', { exact: true }).first()).toBeVisible();
  });
});
