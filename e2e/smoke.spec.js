// Always-on checks: the built app starts, the sign-in page is usable on
// desktop and phone, and protected pages do not open without signing in.
// Nothing here signs in or writes data.
import { expect, test } from '@playwright/test';

test('sign-in page loads with email and password', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Sign in/ })).toBeEnabled();
  expect(errors, 'no JavaScript errors on load').toEqual([]);
});

test('protected pages show sign-in instead of data', async ({ page }) => {
  for (const path of ['/advances', '/cash-board', '/receivables', '/management-report']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  }
});

test('email field is required before signing in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  const valid = await page.getByLabel('Email').evaluate(input => input.checkValidity());
  expect(valid).toBe(false);
});

test('app can be installed (manifest and service worker)', async ({ page }) => {
  await page.goto('/');
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifest).toBeTruthy();
  const response = await page.request.get(manifest);
  expect(response.ok()).toBe(true);
  expect((await page.request.get('/sw.js')).ok()).toBe(true);
});
