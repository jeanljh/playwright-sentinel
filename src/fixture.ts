import { test as base, expect } from '@playwright/test';
import { SEVERITY_RANK } from './classify';
import { IssueCollector } from './collector';
import { ATTACHMENT_NAME, type CapturedIssue, type WatchdogHandle, type WatchdogOptions } from './types';

export interface WatchdogFixtures {
  /** Set under `use` in the config, or per file with `test.use()`. */
  watchdogOptions: WatchdogOptions;
  /** Runs automatically. Request it only to call `watchdog.allow()`. */
  watchdog: WatchdogHandle;
}

function describeFailure(issues: CapturedIssue[], threshold: string): string {
  const lines = issues.map((i) => `  [${i.severity}] ${i.category}: ${i.message.split('\n')[0].slice(0, 200)}`);
  return `Watchdog found ${issues.length} browser issue(s) at or above "${threshold}" severity:\n${lines.join('\n')}`;
}

export const test = base.extend<WatchdogFixtures>({
  watchdogOptions: [{}, { option: true }],

  watchdog: [
    async ({ context, watchdogOptions, baseURL }, use, testInfo) => {
      const collector = new IssueCollector(watchdogOptions, baseURL);
      await collector.attach(context);

      await use(collector.handle);

      const result = await collector.finalize();
      await testInfo.attach(ATTACHMENT_NAME, {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });

      const threshold = watchdogOptions.failOn ?? 'none';
      if (threshold === 'none') return;
      const offending = result.issues.filter((i) => SEVERITY_RANK[i.severity] >= SEVERITY_RANK[threshold]);
      if (offending.length > 0) throw new Error(describeFailure(offending, threshold));
    },
    { auto: true, title: 'playwright sentinel' },
  ],
});

export { expect };
