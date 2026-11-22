import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import WatchdogReporter from '../../src/reporter';
import type { WatchdogReport, WatchdogReporterOptions } from '../../src/report-types';
import { ATTACHMENT_NAME, type CapturedIssue, type TestCaptureResult } from '../../src/types';

test.beforeAll(() => {
  // These variables override reporter options; keep them from leaking in from the shell.
  delete process.env.WATCHDOG_UPDATE_BASELINE;
  delete process.env.WATCHDOG_AI;
  delete process.env.GITHUB_STEP_SUMMARY;
});

const writeToStdout = process.stdout.write;
test.beforeEach(() => {
  process.stdout.write = (() => true) as typeof process.stdout.write;
});
test.afterEach(() => {
  process.stdout.write = writeToStdout;
});

function issue(overrides: Partial<CapturedIssue> & Pick<CapturedIssue, 'fingerprint'>): CapturedIssue {
  return {
    category: 'console-error',
    severity: 'medium',
    message: `message for ${overrides.fingerprint}`,
    normalized: `message for ${overrides.fingerprint}`,
    count: 1,
    thirdParty: false,
    firstSeenMs: 10,
    ...overrides,
  };
}

function fakeTest(id: string, title: string, file: string): TestCase {
  const parent = { type: 'file', title: file, parent: undefined, project: () => ({ name: 'demo' }) };
  return { id, title, parent, location: { file, line: 7, column: 1 } } as unknown as TestCase;
}

function fakeResult(capture: TestCaptureResult | null, status: TestResult['status'] = 'passed'): TestResult {
  const attachments = capture
    ? [{ name: ATTACHMENT_NAME, contentType: 'application/json', body: Buffer.from(JSON.stringify(capture)) }]
    : [];
  return { status, attachments } as unknown as TestResult;
}

function capture(...issues: CapturedIssue[]): TestCaptureResult {
  return { version: 1, issues, ignored: 1, allowed: 0 };
}

async function runReporter(
  dir: string,
  options: WatchdogReporterOptions,
  tests: Array<[TestCase, TestResult]>,
  runStatus: FullResult['status'] = 'passed',
) {
  const reporter = new WatchdogReporter({ outputDir: 'out', ...options });
  reporter.onBegin({ configFile: path.join(dir, 'playwright.config.ts') } as unknown as FullConfig, {} as Suite);
  for (const [t, r] of tests) reporter.onTestEnd(t, r);
  const override = await reporter.onEnd({ status: runStatus } as FullResult);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'watchdog-report.json'), 'utf8')) as WatchdogReport;
  return { override, report };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
}

test('groups issues across tests and writes JSON, Markdown and HTML reports', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'tests', 'shop.spec.ts');
  const { override, report } = await runReporter(dir, {}, [
    [fakeTest('t1', 'home', file), fakeResult(capture(issue({ fingerprint: 'aaa', severity: 'high', category: 'http-5xx', count: 2 }), issue({ fingerprint: 'bbb' })))],
    [fakeTest('t2', 'cart', file), fakeResult(capture(issue({ fingerprint: 'aaa', severity: 'high', category: 'http-5xx' })))],
    [fakeTest('t3', 'clean', file), fakeResult(capture())],
    [fakeTest('t4', 'no fixture', file), fakeResult(null)],
  ]);

  expect(override).toBeUndefined();
  expect(report.totals).toMatchObject({ groups: 2, occurrences: 4, testsScanned: 3, testsWithIssues: 2, ignored: 3 });
  expect(report.totals.bySeverity).toEqual({ high: 1, medium: 1, low: 0 });

  const [first, second] = report.groups;
  expect(first.fingerprint).toBe('aaa');
  expect(first.occurrences).toBe(3);
  expect(first.tests.map((t) => t.title)).toEqual(['home', 'cart']);
  expect(first.tests[0].file).toBe('tests/shop.spec.ts');
  expect(first.coOccursWith).toEqual(['bbb']);
  expect(second.coOccursWith).toEqual(['aaa']);
  expect(first.isNew).toBeNull();

  expect(fs.readFileSync(path.join(dir, 'out', 'watchdog-report.md'), 'utf8')).toContain('**2 issue groups**');
  expect(fs.existsSync(path.join(dir, 'out', 'index.html'))).toBe(true);
});

test('baseline marks new issues and failOnNew fails an otherwise passing run', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.spec.ts');
  const options: WatchdogReporterOptions = { baselineFile: 'baseline.json', failOnNew: 'medium' };

  const first = await runReporter(dir, { ...options, updateBaseline: true }, [
    [fakeTest('t1', 'one', file), fakeResult(capture(issue({ fingerprint: 'known' })))],
  ]);
  expect(first.override).toBeUndefined();
  expect(first.report.baseline).toMatchObject({ found: false, updated: true });
  expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8')).issues)).toEqual(['known']);

  const onlyLowNew = await runReporter(dir, options, [
    [fakeTest('t1', 'one', file), fakeResult(capture(issue({ fingerprint: 'known' }), issue({ fingerprint: 'minor', severity: 'low' })))],
  ]);
  expect(onlyLowNew.override).toBeUndefined();
  expect(onlyLowNew.report.failOnNew).toMatchObject({ triggered: false, offending: [] });

  const second = await runReporter(dir, options, [
    [fakeTest('t1', 'one', file), fakeResult(capture(issue({ fingerprint: 'known' }), issue({ fingerprint: 'fresh', severity: 'high' })))],
  ]);
  expect(second.override).toEqual({ status: 'failed' });
  expect(second.report.groups.map((g) => [g.fingerprint, g.isNew])).toEqual([
    ['fresh', true],
    ['known', false],
  ]);
  expect(second.report.baseline).toMatchObject({ found: true, newGroups: 1, knownGroups: 1, notSeen: [] });
  expect(second.report.failOnNew).toEqual({ threshold: 'medium', triggered: true, offending: ['fresh'] });
});

test('failOnNew leaves an already failed run alone', async () => {
  const dir = tempDir();
  const { override, report } = await runReporter(
    dir,
    { failOnNew: 'low' },
    [[fakeTest('t1', 'one', path.join(dir, 'a.spec.ts')), fakeResult(capture(issue({ fingerprint: 'x' })), 'failed')]],
    'failed',
  );
  expect(report.failOnNew?.triggered).toBe(true);
  expect(override).toBeUndefined();
});

test('the HTML report cannot be broken out of by page content', async () => {
  const dir = tempDir();
  await runReporter(dir, {}, [
    [
      fakeTest('t1', 'xss', path.join(dir, 'a.spec.ts')),
      fakeResult(capture(issue({ fingerprint: 'evil', message: '</script><script>alert(1)</script>' }))),
    ],
  ]);
  const html = fs.readFileSync(path.join(dir, 'out', 'index.html'), 'utf8');
  expect(html).not.toContain('</script><script>alert(1)');
  expect(html).toContain('\\u003c/script>');
});
