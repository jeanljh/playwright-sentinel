// Shows the per-test strict mode: with failOn set, a test fails when the page logs a
// serious error, even though everything it asserts on is correct.
import { expect, test } from '../../src';

test.use({ watchdogOptions: { failOn: 'high' } });

test('strict mode fails a test whose page throws', async ({ page }) => {
  test.fail(true, 'The cart page throws a TypeError and leaves a promise rejection unhandled');
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.locator('#count')).toHaveText('1');
});
