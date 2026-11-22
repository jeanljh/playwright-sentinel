// Drives the demo app in a real browser and checks what the collector records.
import { expect, test } from '@playwright/test';
import { IssueCollector } from '../../src/collector';
import type { CapturedIssue, WatchdogOptions } from '../../src/types';

async function capture(
  context: import('@playwright/test').BrowserContext,
  baseURL: string | undefined,
  run: (collector: IssueCollector) => Promise<void>,
  options: WatchdogOptions = {},
) {
  const collector = new IssueCollector(options, baseURL);
  await collector.attach(context);
  await run(collector);
  return collector.finalize();
}

function byCategory(issues: CapturedIssue[], category: CapturedIssue['category']) {
  return issues.filter((i) => i.category === category);
}

test('tells unhandled rejections apart from uncaught exceptions', async ({ context, page, baseURL }) => {
  const result = await capture(context, baseURL, async () => {
    await page.goto('/cart');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.locator('#count')).toHaveText('1');
  });

  const [rejection] = byCategory(result.issues, 'unhandled-rejection');
  expect(rejection.message).toContain('Analytics queue not initialized');
  expect(rejection.severity).toBe('high');

  const [exception] = byCategory(result.issues, 'uncaught-exception');
  // Each browser words this TypeError differently, but all of them name the property.
  expect(exception.message).toMatch(/^TypeError: .*items/);
  expect(exception.location?.url).toBe(`${baseURL}/cart`);
  expect(exception.thirdParty).toBe(false);

  expect(byCategory(result.issues, 'hydration')).toHaveLength(1);
});

test('records CORS errors once, without a duplicate failed-request issue', async ({ context, page, baseURL }) => {
  const result = await capture(context, baseURL, async () => {
    await page.goto('/cart');
    await expect(page.locator('#stock')).toHaveText('Stock info unavailable');
  });
  const cors = byCategory(result.issues, 'cors');
  expect(cors).toHaveLength(1);
  expect(cors[0].message).toContain('127.0.0.1');
  expect(byCategory(result.issues, 'request-failed')).toHaveLength(0);
  expect(byCategory(result.issues, 'uncaught-exception')).toHaveLength(0);
});

test('captures 5xx responses with a redacted body and GraphQL errors behind a 200', async ({ context, page, baseURL }) => {
  const result = await capture(context, baseURL, async () => {
    await page.goto('/products');
    await expect(page.locator('#reviews')).toHaveText('No reviews yet');
  });

  const [serverError] = byCategory(result.issues, 'http-5xx');
  expect(serverError.request).toMatchObject({ method: 'GET', status: 500, resourceType: 'fetch' });
  expect(serverError.request?.bodySnippet).toContain('recommendation-service timed out');

  const [graphql] = byCategory(result.issues, 'graphql-error');
  expect(graphql.message).toContain('Cannot query field "rating" on type "Review"');
  expect(graphql.request?.status).toBe(200);

  expect(byCategory(result.issues, 'framework-warning')[0].message).toContain('unique "key" prop');
  expect(byCategory(result.issues, 'console-error')[0].message).toContain('Failed to load recommendations');
  // Chromium's own "Failed to load resource" console lines are dropped as duplicates.
  expect(result.issues.some((i) => i.message.startsWith('Failed to load resource'))).toBe(false);
});

test('groups requests that differ only by id, and masks secrets in bodies', async ({ context, page, baseURL }) => {
  const result = await capture(context, baseURL, async () => {
    for (const email of ['a@example.com', 'b@example.com']) {
      await page.goto('/checkout');
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Place order' }).click();
      await expect(page.locator('#result')).toHaveText(/Order \d+ placed/);
    }
  });

  const receipts = byCategory(result.issues, 'http-4xx').filter((i) => i.request?.url.includes('/receipt'));
  expect(receipts).toHaveLength(1);
  expect(receipts[0].count).toBe(2);
  expect(receipts[0].request?.bodySnippet).toContain('<email>');
  expect(receipts[0].request?.bodySnippet).toContain('"token":"<redacted>"');
  expect(receipts[0].request?.bodySnippet).not.toContain('jane.doe@example.com');
});

test('flags third-party errors, downgrades them, and applies default ignores', async ({ context, page, baseURL }) => {
  const result = await capture(context, baseURL, async () => {
    await page.goto('/');
    await expect(page.locator('#banner')).toHaveText('Free shipping over $50');
  });

  const [widget] = byCategory(result.issues, 'uncaught-exception');
  expect(widget.thirdParty).toBe(true);
  expect(widget.severity).toBe('medium');
  expect(widget.location?.url).toContain('/vendor/chat-widget.js');

  const missingCss = byCategory(result.issues, 'http-4xx');
  expect(missingCss.map((i) => i.request?.url)).toEqual([`${baseURL}/static/theme-v2.css`]);
  expect(byCategory(result.issues, 'console-warning')).toHaveLength(1);
});

test('ignoreThirdParty and custom ignore rules drop issues and count them', async ({ context, page, baseURL }) => {
  const result = await capture(
    context,
    baseURL,
    async () => {
      await page.goto('/');
      await expect(page.locator('#banner')).toHaveText('Free shipping over $50');
    },
    { ignoreThirdParty: true, ignore: [{ category: 'console-warning', message: /deprecated/ }] },
  );
  expect(result.issues.map((i) => i.category)).toEqual(['http-4xx']);
  expect(result.ignored).toBeGreaterThanOrEqual(2);
});

test('allow() marks expected issues instead of reporting them', async ({ context, page, baseURL }) => {
  const result = await capture(context, baseURL, async (collector) => {
    collector.handle.allow({ category: 'http-4xx', url: '/does-not-exist' });
    await page.goto('/does-not-exist');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
  expect(result.issues.find((i) => i.request?.url.includes('/does-not-exist'))).toBeUndefined();
  expect(result.allowed).toBe(1);
});
