# Playwright Sentinel

[![CI](https://github.com/jeanljh/playwright-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/jeanljh/playwright-sentinel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Your UI tests can pass while the page throws errors and API calls fail behind the scenes. Playwright Sentinel watches every test for the problems your assertions never check, and turns them into one bug list.

It catches JavaScript exceptions, unhandled promise rejections, console errors, hydration mismatches, CORS and CSP errors, failed requests, and API calls that return errors. Each problem is grouped across tests and runs. A baseline file lets CI fail only when something new shows up. Claude can optionally triage the list for you.

```
[watchdog] 12 issue group(s), 23 occurrence(s) in 7 of 7 test(s): 4 high, 7 medium, 1 low, 1 new since the baseline.
  HIGH   uncaught-exception  TypeError: Cannot read properties of undefined (reading 'items') (2 tests, 2x)
  HIGH   unhandled-rejection Analytics queue not initialized: dropped event add_to_cart (2 tests, 2x)
  HIGH   http-5xx            GET http://localhost:4319/api/recommendations returned 500 Internal Server Error (1 test, 1x)
  HIGH   graphql-error       GraphQL error from POST http://localhost:4319/graphql: Cannot query field "rating" on typ… (1 test, 1x)
  MEDIUM console-error       Price service returned stale prices for 4 products (1 test, 1x) [NEW]
  ...
[watchdog] Failing the run: 1 new issue group(s) at "medium" or above.
[watchdog] Report: watchdog-report/index.html
```

## Features

- Works with your existing tests. You change one import.
- Groups the same problem across tests, even when IDs, query strings or build hashes in URLs change.
- Captures the start of the response body for failed API calls.
- Finds GraphQL errors hidden inside 200 responses.
- Marks problems from other sites' scripts as third-party and ranks them lower.
- Masks tokens, passwords and email addresses before anything is saved.
- Writes an HTML report, a JSON file and a Markdown summary. On GitHub Actions, the summary shows up on the job page.
- Optional AI triage with Claude, through an API key or your Claude Code login.

## What it catches

| Category | Default severity | What it is |
|---|---|---|
| `uncaught-exception` | high | Errors thrown in the page and never caught |
| `unhandled-rejection` | high | Promises rejected with no handler |
| `http-5xx` | high | Responses with status 500–599 |
| `graphql-error` | high | GraphQL responses with status 200 that contain an `errors` array |
| `hydration` | medium | Server and client markup mismatches (React, Next.js and similar) |
| `console-error` | medium | `console.error` calls and failed `console.assert` checks |
| `cors`, `csp`, `mixed-content` | medium | Requests or content the browser blocked for security reasons |
| `request-failed` | medium | Requests that got no response: DNS errors, refused connections, blocked requests |
| `http-4xx` | medium | Responses with status 400–499 |
| `framework-warning` | low | React `Warning:`, `[Vue warn]` and Angular `NG0xxx` messages |
| `console-warning` | low | `console.warn` calls |

Some noise is dropped by default:

- favicon 404s
- requests cancelled because the page navigated away
- errors from browser extensions
- Chromium's "Failed to load resource" console lines, because the network log already records the same failure with more detail

## Installation

The package isn't on npm yet. Install it from GitHub:

```bash
npm install --save-dev github:jeanljh/playwright-sentinel
```

Or from a local clone:

```bash
npm install --save-dev ../playwright-sentinel
```

Either way, the package compiles itself during install. It needs `@playwright/test` 1.40 or later.

## Quick start

In your tests, import `test` and `expect` from the plugin instead of `@playwright/test`:

```ts
import { test, expect } from 'playwright-sentinel';

test('checkout works', async ({ page }) => {
  await page.goto('/checkout');
  // ...the rest of your test stays the same
});
```

Then add the reporter to `playwright.config.ts`, next to the reporter you already use:

```ts
import { defineConfig } from '@playwright/test';
import type { WatchdogFixtures, WatchdogReporterOptions } from 'playwright-sentinel';

export default defineConfig<WatchdogFixtures>({
  reporter: [
    ['list'],
    ['playwright-sentinel/reporter', {
      baselineFile: 'watchdog-baseline.json',
      failOnNew: 'medium',
    } satisfies WatchdogReporterOptions],
  ],
  use: {
    baseURL: 'http://localhost:3000',
    watchdogOptions: {
      ignore: [{ url: /hotjar\.com/, reason: 'Session recording script' }],
    },
  },
});
```

> Passing `--reporter` on the command line replaces every reporter in your config, including this one.

## Reports

Each run writes three files to `watchdog-report/`:

| File | What it contains |
|---|---|
| `index.html` | A page you can search and filter. For each problem it shows the tests that hit it, page and source locations, request details, response bodies and stack traces. |
| `watchdog-report.json` | The same data for scripts and dashboards |
| `watchdog-report.md` | A short summary for pull request comments |

## Configuration

### Test options

Set `watchdogOptions` under `use` in your config, or per file with `test.use({ watchdogOptions: { ... } })`. A value set per file replaces the config value entirely. The two are not merged.

| Option | Default | What it does |
|---|---|---|
| `ignore` | `[]` | Rules for problems to drop in every test (see [Rules](#rules)) |
| `useDefaultIgnores` | `true` | Keeps the default noise filters on |
| `captureWarnings` | `true` | Records `console.warn` |
| `firstPartyOrigins` | baseURL and pages the test opens | Origins that count as your app |
| `ignoreThirdParty` | `false` | Drops everything from other origins |
| `failOn` | `'none'` | Fails the test itself on a problem at or above this severity |
| `detectGraphQLErrors` | `true` | Checks GraphQL responses for an `errors` array |
| `bodySnippetLength` | `600` | How many characters of a failed response body to keep. `0` turns this off. |
| `severityOverrides` | `{}` | Changes a category's severity, for example `{ 'http-4xx': 'low' }` |
| `settleMs` | `100` | How long to keep listening after a test ends, to catch late errors |

### Rules

A rule matches when all of its conditions match. Strings match anywhere in the text. You can also use regular expressions.

```ts
{ category: 'http-4xx', url: '/api/optional-feature', reason: 'Returns 404 when the feature is off' }
{ message: /ResizeObserver loop/, reason: 'Harmless browser warning' }
{ pageUrl: '/legacy/', reason: 'Old pages, tracked in JIRA-123' }
```

- `url` matches the failing request, or the script that logged or threw the error.
- `pageUrl` matches the page where the problem happened.
- `category` takes one category or a list of them.

### Expected errors

Some tests trigger an error on purpose. Declare those errors with `watchdog.allow()` so they don't show up as problems:

```ts
test('shows a 404 page', async ({ page, watchdog }) => {
  watchdog.allow({ category: 'http-4xx', url: '/does-not-exist' });
  await page.goto('/does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
```

### Reporter options

| Option | Default | What it does |
|---|---|---|
| `outputDir` | `'watchdog-report'` | Where the reports are written |
| `baselineFile` | none | JSON file of known problems. Anything not in it is marked new. |
| `updateBaseline` | `false` | Rewrites the baseline from this run. `WATCHDOG_UPDATE_BASELINE=1` does the same. |
| `failOnNew` | `'none'` | Fails the run when a new problem at or above this severity appears, even if every test passed |
| `ai` | off | Claude triage (see [AI triage](#ai-triage)) |
| `printTop` | `10` | How many problems to list in the terminal |

## Baselines and CI

Most apps already have some console noise. A baseline lets you start using Sentinel without fixing all of it first. Record what's there today, then fail only on new problems.

Record a baseline:

```bash
WATCHDOG_UPDATE_BASELINE=1 npx playwright test
```

In PowerShell:

```powershell
$env:WATCHDOG_UPDATE_BASELINE = '1'; npx playwright test; Remove-Item Env:WATCHDOG_UPDATE_BASELINE
```

Commit `watchdog-baseline.json`. With `failOnNew: 'medium'`, CI then fails whenever a new medium or high problem appears. Record the baseline again after you fix or accept problems.

Each browser words some errors differently. For example, the same TypeError reads differently in Chromium, Firefox and WebKit, so each version gets its own fingerprint. If you test on more than one browser, record the baseline with all of them in the same run.

Fingerprints ignore whatever changes between runs: IDs and numbers, query strings, build hashes and line numbers. For example, a 404 on `/api/orders/48213/receipt` and a 404 on `/api/orders/99120/receipt` count as the same problem. Without a baseline file, every problem counts as new.

On GitHub Actions you don't need any extra setup for the summary. To keep the HTML report, upload it as an artifact:

```yaml
- run: npx playwright test
- uses: actions/upload-artifact@v7
  if: always()
  with:
    name: watchdog-report
    path: watchdog-report/
```

## AI triage

Claude can review the problem list at the end of a run. It looks at the 30 most severe groups by default. For each one, it returns:

- a verdict: bug, needs investigation, or noise
- a severity based on the impact on users
- a title you could use for a ticket
- the likely cause, including links between related problems, such as a 500 response and the TypeError it causes
- a suggested fix and the team that probably owns it

It also writes a short summary of what to fix first. All of this goes into every report.

Turn it on in the reporter options:

```ts
['playwright-sentinel/reporter', { ai: { enabled: true } }]
```

To turn it on for a single run, set `WATCHDOG_AI=1` instead.

### Connecting to Claude

There are two ways to reach Claude:

- **Claude Code login.** You don't need an API key. If the `claude` CLI is installed and signed in, Sentinel runs it once with tools, MCP servers, hooks and session saving turned off. Each run counts toward your Claude plan's usage.
- **Anthropic API.** Set `ANTHROPIC_API_KEY`, which is billed separately from a Claude subscription. If the model declines the request, the API retries it on a fallback model within the same call (`fallbacks: "default"`).

By default, Sentinel uses the API when a key is set, and Claude Code otherwise. To choose one yourself, set `ai.provider` to `'api'` or `'claude-code'`.

Triage never fails your test run. If something goes wrong, the report says what: missing credentials, a timeout, or an API error.

| Option | Default | What it does |
|---|---|---|
| `ai.model` | `'claude-opus-5-5'` | The model to use. `'claude-sonnet-5-5'` is a cheaper alternative. |
| `ai.effort` | `'medium'` | How much effort the model puts into its answer |
| `ai.maxGroups` | `30` | How many of the most severe groups to send |
| `ai.provider` | `'auto'` | `'auto'`, `'api'` or `'claude-code'` |
| `ai.claudePath` | `claude` on PATH | Path to the Claude Code CLI. On Windows, this must be the native `claude.exe`. |
| `ai.timeoutMs` | 5 minutes | How long to wait for Claude Code |

In CI, an API key stored as a secret is the simplest setup. To use your Claude subscription in CI instead, create a token with `claude setup-token` and store it as the `CLAUDE_CODE_OAUTH_TOKEN` secret.

**What gets sent to Claude:** problem messages, page and request URLs, stack traces and short excerpts of response bodies. Tokens, passwords and email addresses are masked first. Masking relies on patterns, so it can miss things. Check the JSON report before turning triage on for an app that handles sensitive data.

## How it works

- An automatic fixture listens to the test's browser context. That covers every page and popup the test opens.
- Playwright reports unhandled promise rejections the same way as uncaught exceptions. A small script injected into each page tells the two apart.
- When a test ends, its problems are attached to the test result. The reporter merges them by fingerprint, compares them with the baseline and writes the reports.

## Try the demo

This repository includes a small shop app with planted bugs. Its UI tests all pass.

```bash
npm install
npx playwright install chromium firefox webkit
npm run demo
```

Plant one more bug and run the demo again. Every test still passes, but the run fails:

```bash
DEMO_EXTRA_BUG=1 npm run demo
```

| Command | What it runs |
|---|---|
| `npm run demo` | The demo on Chromium |
| `npm run demo:all` | The demo on Chromium, Firefox and WebKit |
| `npm test` | Unit tests, plus the integration tests and the demo on all three browsers |

## Limitations

- It has been tested on Chromium, Firefox and WebKit, as bundled with Playwright. Branded browsers such as Chrome, Edge or Safari haven't been tested.
- Hydration detection matches the messages React and similar frameworks log. A framework that words them differently will show up as a plain `console-error`.
- Only the built-in `page` and `context` fixtures are watched. Contexts you create with `browser.newContext()` are not.
- Errors from Web Workers and Service Workers haven't been tested.
- When you shard a run, each shard writes its own report. They can't be merged yet.
- `failOn` fails a test after it finishes, so the failure is reported as an error in fixture teardown.

## License

[MIT](LICENSE)
