import { SEVERITY_RANK } from './classify';
import type { GroupTest, IssueGroup } from './report-types';
import { CATEGORIES, type TestCaptureResult } from './types';

const MAX_EXAMPLES = 3;
const MAX_CO_OCCURRING = 10;

export function compareGroups(a: IssueGroup, b: IssueGroup): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    Number(b.isNew === true) - Number(a.isNew === true) ||
    b.tests.length - a.tests.length ||
    b.occurrences - a.occurrences ||
    CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

/** Merges per-test issues into run-wide groups by fingerprint. */
export class GroupAggregator {
  private readonly groups = new Map<string, IssueGroup>();
  private readonly fingerprintsByTest = new Map<string, Set<string>>();
  private readonly scannedTests = new Set<string>();
  ignored = 0;
  allowed = 0;

  add(test: GroupTest, capture: TestCaptureResult): void {
    this.scannedTests.add(test.id);
    this.ignored += capture.ignored;
    this.allowed += capture.allowed;
    if (capture.issues.length === 0) return;

    const seenInTest = this.fingerprintsByTest.get(test.id) ?? new Set<string>();
    this.fingerprintsByTest.set(test.id, seenInTest);

    for (const issue of capture.issues) {
      seenInTest.add(issue.fingerprint);
      let group = this.groups.get(issue.fingerprint);
      if (!group) {
        group = {
          fingerprint: issue.fingerprint,
          category: issue.category,
          severity: issue.severity,
          message: issue.message,
          normalized: issue.normalized,
          occurrences: 0,
          thirdParty: issue.thirdParty,
          isNew: null,
          tests: [],
          examples: [],
          coOccursWith: [],
        };
        this.groups.set(issue.fingerprint, group);
      }
      group.occurrences += issue.count;
      if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[group.severity]) group.severity = issue.severity;
      group.thirdParty = group.thirdParty && issue.thirdParty;

      const knownTest = group.tests.find((t) => t.id === test.id);
      if (knownTest) knownTest.status = test.status;
      else group.tests.push({ ...test });

      const duplicateExample = group.examples.some(
        (e) => e.pageUrl === issue.pageUrl && e.request?.url === issue.request?.url,
      );
      if (group.examples.length < MAX_EXAMPLES && !duplicateExample) {
        group.examples.push({
          pageUrl: issue.pageUrl,
          location: issue.location,
          stack: issue.stack,
          request: issue.request,
        });
      }
    }
  }

  get testsScanned(): number {
    return this.scannedTests.size;
  }

  get testsWithIssues(): number {
    return this.fingerprintsByTest.size;
  }

  build(): IssueGroup[] {
    for (const group of this.groups.values()) {
      const related = new Set<string>();
      for (const test of group.tests) {
        for (const fingerprint of this.fingerprintsByTest.get(test.id) ?? []) {
          if (fingerprint !== group.fingerprint) related.add(fingerprint);
        }
      }
      group.coOccursWith = [...related].slice(0, MAX_CO_OCCURRING);
    }
    return [...this.groups.values()].sort(compareGroups);
  }
}
