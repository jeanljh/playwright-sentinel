// Ordinary UI tests for the demo shop. They only check what users see, and they all pass.
// The watchdog fixture runs alongside them and records the browser problems they never look at.
import { expect, test } from '../../src';

test('home page shows the welcome banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to ShopLite' })).toBeVisible();
  await expect(page.locator('#banner')).toHaveText('Free shipping over $50');
});

test('product list loads', async ({ page }) => {
  await page.goto('/products');
  await expect(page.locator('#list li')).toHaveCount(3);
  await expect(page.locator('#reviews')).toHaveText('No reviews yet');
});

test('adding to cart updates the counter', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.locator('#stock')).toHaveText('Stock info unavailable');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.locator('#count')).toHaveText('1');
});

test.describe('checkout', () => {
  test('places an order', async ({ page }) => {
    await page.goto('/checkout');
    await page.getByLabel('Email').fill('shopper@example.com');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page.locator('#result')).toHaveText(/Order \d+ placed/);
  });

  test('places a second order', async ({ page }) => {
    await page.goto('/checkout');
    await page.getByLabel('Email').fill('another@example.com');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page.locator('#result')).toHaveText(/Order \d+ placed/);
  });
});

test('unknown pages show a friendly 404', async ({ page, watchdog }) => {
  // This test visits a missing page on purpose, so its 404 is expected rather than a bug.
  watchdog.allow({ category: 'http-4xx', url: '/does-not-exist' });
  await page.goto('/does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
