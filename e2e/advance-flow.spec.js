// The whole advance workflow through the real screens, with three people:
//   staff requests -> admin approves -> finance releases -> staff records an
//   expense with a receipt and submits -> admin approves the settlement ->
//   finance closes it.
// Runs only when the test accounts are set (see e2e/README.md). It creates real
// records, so point it at a TEST Supabase project.
import { expect, test } from '@playwright/test';

const env = name => process.env[name] || '';
const accounts = {
  staff: { email: env('E2E_STAFF_EMAIL'), password: env('E2E_STAFF_PASSWORD') },
  admin: { email: env('E2E_ADMIN_EMAIL'), password: env('E2E_ADMIN_PASSWORD') },
  finance: { email: env('E2E_FINANCE_EMAIL'), password: env('E2E_FINANCE_PASSWORD') },
};
const ready = Object.values(accounts).every(a => a.email && a.password);
const purpose = `E2E advance ${Date.now()}`;
const AMOUNT = '1000';
// 1x1 PNG used as the receipt photo.
const RECEIPT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.describe.configure({ mode: 'serial' });
test.skip(!ready, 'Set E2E_STAFF_*, E2E_ADMIN_* and E2E_FINANCE_* to run the advance workflow.');

async function signIn(browser, who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(accounts[who].email);
  await page.getByLabel('Password').fill(accounts[who].password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden();
  return { page, close: () => context.close() };
}

// Opens the "…" menu of the row whose text contains the test purpose.
async function rowAction(page, path, action) {
  await page.goto(path);
  await page.getByPlaceholder(/^Search/).fill(purpose);
  const row = page.locator('tr', { hasText: purpose }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

const confirmAsk = (page, label) => page.getByRole('button', { name: label, exact: true }).last().click();

test('staff requests an advance', async ({ browser }) => {
  const { page, close } = await signIn(browser, 'staff');
  await page.goto('/my-advances');
  await page.getByRole('button', { name: 'Request advance' }).click();
  const modal = page.locator('.modal');
  const job = modal.locator('label', { hasText: 'Job order' }).locator('select');
  await job.selectOption({ index: 1 });
  const today = new Date().toISOString().slice(0, 10);
  await modal.locator('label', { hasText: 'Request date' }).locator('input').fill(today);
  await modal.locator('label', { hasText: 'Expected settlement date' }).locator('input').fill(today);
  await modal.locator('label', { hasText: 'Requested amount' }).locator('input').fill(AMOUNT);
  await modal.locator('label', { hasText: 'Business purpose' }).locator('textarea').fill(purpose);
  await modal.getByRole('button', { name: 'Request staff advance' }).click();
  await expect(page.getByText('Advance request submitted for approval.')).toBeVisible();
  await close();
});

test('admin approves the request', async ({ browser }) => {
  const { page, close } = await signIn(browser, 'admin');
  await rowAction(page, '/advances', 'Approve');
  await expect(page.locator('tr', { hasText: purpose }).getByText('Approved')).toBeVisible();
  await close();
});

test('finance releases the money', async ({ browser }) => {
  const { page, close } = await signIn(browser, 'finance');
  await rowAction(page, '/advances', 'Release money');
  await page.getByPlaceholder('Voucher / transfer reference').fill('E2E-VOUCHER');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText(/Money released/)).toBeVisible();
  await close();
});

test('staff records an expense with a receipt and submits', async ({ browser }) => {
  const { page, close } = await signIn(browser, 'staff');
  await rowAction(page, '/my-advances', 'Advance details');
  const win = page.locator('.advx-modal');
  await win.getByLabel('What was it for?').fill('E2E fuel');
  await win.getByLabel('Amount (MMK)').fill(AMOUNT);
  await win.locator('input[type=file][multiple]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: RECEIPT });
  await win.getByRole('button', { name: 'Save draft' }).click();
  await expect(win.getByText('E2E fuel')).toBeVisible();
  await win.getByRole('button', { name: /Submit to manager/ }).click();
  await confirmAsk(page, 'Submit');
  await expect(win.getByText(/manager is reviewing/i)).toBeVisible();
  await close();
});

test('admin approves the settlement', async ({ browser }) => {
  const { page, close } = await signIn(browser, 'admin');
  await rowAction(page, '/advances', 'Review settlement');
  await page.locator('.advx-modal').getByRole('button', { name: 'Approve settlement' }).click();
  await confirmAsk(page, 'Approve');
  await expect(page.getByText('Settlement approved.')).toBeVisible();
  await close();
});

test('finance closes the advance', async ({ browser }) => {
  const { page, close } = await signIn(browser, 'finance');
  await rowAction(page, '/advances', 'Reconcile & close');
  await page.locator('.advx-modal').getByRole('button', { name: /close|Close advance/ }).last().click();
  await confirmAsk(page, 'Close advance');
  await expect(page.getByText('Advance closed.')).toBeVisible();
  await close();
});
