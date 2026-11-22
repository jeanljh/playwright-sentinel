export { test, expect, type WatchdogFixtures } from './fixture';
export { IssueCollector } from './collector';
export { DEFAULT_IGNORES, DEFAULT_SEVERITY, normalizeMessage, normalizeUrl, redact } from './classify';
export type { WatchdogReporterOptions, WatchdogReport, IssueGroup, TriageProvider } from './report-types';
export * from './types';
