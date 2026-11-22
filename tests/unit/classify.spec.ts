import { expect, test } from '@playwright/test';
import {
  classifyConsole,
  fingerprintOf,
  isThirdParty,
  matchesRule,
  normalizeMessage,
  normalizeUrl,
  parseTopFrame,
  redact,
  unwrapConsoleText,
} from '../../src/classify';

test.describe('normalizeUrl', () => {
  test('replaces id-like path segments and drops query and hash', () => {
    expect(normalizeUrl('https://shop.test/api/orders/48213/receipt?token=abc#top')).toBe(
      'https://shop.test/api/orders/:id/receipt',
    );
    expect(normalizeUrl('https://shop.test/u/3f2b1c0d-1111-4a2b-8c9d-0e1f2a3b4c5d/avatar')).toBe(
      'https://shop.test/u/:id/avatar',
    );
    expect(normalizeUrl('https://cdn.test/build/9f8e7d6c5b4a3e21/app.js')).toBe('https://cdn.test/build/:id/app.js');
  });

  test('replaces build hashes in file names so errors keep their fingerprint across deploys', () => {
    expect(normalizeUrl('https://cdn.test/assets/app.9f8e7d6c5b4a3.js')).toBe('https://cdn.test/assets/app.<hash>.js');
    expect(normalizeUrl('https://shop.test/_next/static/chunks/index-3f2a9c8d1e.js')).toBe(
      'https://shop.test/_next/static/chunks/index-<hash>.js',
    );
  });

  test('keeps ordinary words in paths', () => {
    expect(normalizeUrl('https://shop.test/static/theme-v2.css')).toBe('https://shop.test/static/theme-v2.css');
  });
});

test.describe('normalizeMessage', () => {
  test('gives the same text for messages that differ only in ids, numbers and line numbers', () => {
    const a = normalizeMessage('Order 48213 failed at https://shop.test/api/orders/48213?x=1 (app.js:10:5)');
    const b = normalizeMessage('Order 99120 failed at https://shop.test/api/orders/99120?x=2 (app.js:44:19)');
    expect(a).toBe(b);
  });

  test('replaces uuids', () => {
    expect(normalizeMessage('request 3f2b1c0d-1111-4a2b-8c9d-0e1f2a3b4c5d timed out')).toBe('request <uuid> timed out');
  });
});

test('fingerprints are stable and category-specific', () => {
  expect(fingerprintOf('console-error', 'x')).toBe(fingerprintOf('console-error', 'x'));
  expect(fingerprintOf('console-error', 'x')).not.toBe(fingerprintOf('console-warning', 'x'));
  expect(fingerprintOf('console-error', 'x')).toMatch(/^[0-9a-f]{12}$/);
});

test.describe('classifyConsole', () => {
  const cases: Array<[string, string, string | null]> = [
    ['error', 'Failed to load resource: the server responded with a status of 404 (Not Found)', null],
    ['error', "Access to fetch at 'https://api.test/x' from origin 'https://app.test' has been blocked by CORS policy", 'cors'],
    ['error', 'Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource', 'cors'],
    ['error', 'Origin https://app.test is not allowed by Access-Control-Allow-Origin. Status code: 200', 'cors'],
    ['error', 'Fetch API cannot load https://api.test/x due to access control checks.', 'cors'],
    ['error', "Refused to load the script because it violates the following Content Security Policy directive", 'csp'],
    ['warning', "Mixed Content: The page at 'https://a.test' was loaded over HTTPS", 'mixed-content'],
    ['error', "Hydration failed because the server rendered text didn't match the client.", 'hydration'],
    ['error', 'Uncaught Error: Minified React error #418; visit https://react.dev/errors/418', 'hydration'],
    ['error', 'Warning: Each child in a list should have a unique "key" prop.', 'framework-warning'],
    ['warning', '[Vue warn]: Missing required prop: "id"', 'framework-warning'],
    ['error', 'Something broke', 'console-error'],
    ['assert', 'Assertion failed: console.assert', 'console-error'],
    ['warning', 'Slow network detected', 'console-warning'],
    ['log', 'hello', null],
    ['info', 'hello', null],
  ];
  for (const [type, text, expected] of cases) {
    test(`${type}: ${text.slice(0, 40)}`, () => {
      expect(classifyConsole(type, text)).toBe(expected);
    });
  }
});

test('unwrapConsoleText removes the wrapper Firefox puts around some errors', () => {
  expect(unwrapConsoleText('[JavaScript Error: "Cross-Origin Request Blocked: x. Status code: 200."]')).toBe(
    'Cross-Origin Request Blocked: x. Status code: 200.',
  );
  expect(unwrapConsoleText('[JavaScript Warning: "Bad thing" {file: "http://a.test/app.js" line: 3}]')).toBe('Bad thing');
  expect(unwrapConsoleText('plain [JavaScript Error: "x"]')).toBe('plain [JavaScript Error: "x"]');
});

test('redact masks emails, tokens, JWTs and bearer credentials', () => {
  const input =
    '{"customer":"jane.doe@example.com","token":"fake-token-123","auth":"Bearer abc.def-ghi","jwt":"eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl"} ?api_key=XYZ&ok=1';
  const output = redact(input);
  expect(output).not.toContain('jane.doe@example.com');
  expect(output).not.toContain('fake-token-123');
  expect(output).not.toContain('abc.def-ghi');
  expect(output).not.toContain('eyJzdWIiOi');
  expect(output).not.toContain('XYZ');
  expect(output).toContain('ok=1');
});

test('parseTopFrame reads V8 and Firefox stack formats', () => {
  expect(parseTopFrame('TypeError: x\n    at updateMiniCart (https://shop.test/cart:12:27)\n    at https://shop.test/cart:20:7')).toEqual({
    url: 'https://shop.test/cart',
    line: 12,
    column: 27,
  });
  expect(parseTopFrame('updateMiniCart@https://shop.test/static/app.js:3:9\n')).toEqual({
    url: 'https://shop.test/static/app.js',
    line: 3,
    column: 9,
  });
  expect(parseTopFrame('Error: no location')).toBeUndefined();
});

test('isThirdParty compares origins', () => {
  const firstParty = new Set(['https://shop.test']);
  expect(isThirdParty('https://shop.test/app.js', firstParty)).toBe(false);
  expect(isThirdParty('https://cdn.vendor.test/widget.js', firstParty)).toBe(true);
  expect(isThirdParty('data:text/javascript,1', firstParty)).toBe(false);
});

test.describe('matchesRule', () => {
  const target = {
    category: 'http-4xx' as const,
    message: 'GET https://shop.test/favicon.ico returned 404',
    sourceUrls: ['https://shop.test/favicon.ico'],
    pageUrl: 'https://shop.test/products',
  };

  test('matches when every condition matches', () => {
    expect(matchesRule({ category: 'http-4xx', url: /favicon/ }, target)).toBe(true);
    expect(matchesRule({ category: ['http-5xx', 'http-4xx'], message: 'returned 404' }, target)).toBe(true);
    expect(matchesRule({ pageUrl: '/products' }, target)).toBe(true);
  });

  test('fails when any condition fails', () => {
    expect(matchesRule({ category: 'http-5xx', url: /favicon/ }, target)).toBe(false);
    expect(matchesRule({ url: 'other.test' }, target)).toBe(false);
    expect(matchesRule({ url: /favicon/, pageUrl: '/cart' }, target)).toBe(false);
  });

  test('url matches the request or script, not the page', () => {
    expect(matchesRule({ url: '/products' }, target)).toBe(false);
  });

  test('an empty rule matches nothing', () => {
    expect(matchesRule({ reason: 'oops' }, target)).toBe(false);
  });

  test('global regexes work on repeated calls', () => {
    const rule = { url: /favicon/g };
    expect(matchesRule(rule, target)).toBe(true);
    expect(matchesRule(rule, target)).toBe(true);
  });
});
