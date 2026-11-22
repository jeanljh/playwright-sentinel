export const CATEGORIES = [
  'uncaught-exception',
  'unhandled-rejection',
  'http-5xx',
  'graphql-error',
  'hydration',
  'console-error',
  'cors',
  'csp',
  'mixed-content',
  'request-failed',
  'http-4xx',
  'framework-warning',
  'console-warning',
] as const;

export type Category = (typeof CATEGORIES)[number];

export type Severity = 'high' | 'medium' | 'low';

export interface SourceLocation {
  url: string;
  line: number;
  column: number;
}

export interface RequestInfo {
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  bodySnippet?: string;
}

/** One distinct problem in a single test. */
export interface CapturedIssue {
  fingerprint: string;
  category: Category;
  severity: Severity;
  message: string;
  /** Message with ids and numbers stripped. The fingerprint is built from it. */
  normalized: string;
  count: number;
  thirdParty: boolean;
  pageUrl?: string;
  location?: SourceLocation;
  stack?: string;
  request?: RequestInfo;
  /** Time from test start to the first occurrence, in ms. */
  firstSeenMs: number;
}

export interface TestCaptureResult {
  version: 1;
  issues: CapturedIssue[];
  /** Occurrences dropped by ignore rules. */
  ignored: number;
  /** Occurrences marked as expected with `watchdog.allow()`. */
  allowed: number;
}

export interface MatchRule {
  category?: Category | Category[];
  /** Issue message. Strings match as substrings, here and below. */
  message?: string | RegExp;
  /** Failing request URL, or the URL of the script that logged or threw. */
  url?: string | RegExp;
  /** URL of the page where it happened. */
  pageUrl?: string | RegExp;
  /** Why the rule exists. Not used for matching. */
  reason?: string;
}

export interface WatchdogOptions {
  /** Issues to drop in every test. */
  ignore?: MatchRule[];
  /** Drop favicon 404s, cancelled requests and extension errors. Default true. */
  useDefaultIgnores?: boolean;
  /** Record console.warn. Default true. */
  captureWarnings?: boolean;
  /** Origins that count as your app. Default: baseURL plus every page the test opens. */
  firstPartyOrigins?: string[];
  /** Drop issues from other origins. Default false. */
  ignoreThirdParty?: boolean;
  /** Fail the test on an issue at or above this severity. Default 'none'. */
  failOn?: Severity | 'none';
  /** Report GraphQL `errors` in 200 responses. Default true. */
  detectGraphQLErrors?: boolean;
  /** Response body characters kept for failed API calls; 0 turns it off. Default 600. */
  bodySnippetLength?: number;
  severityOverrides?: Partial<Record<Category, Severity>>;
  /** How long to keep listening after the test ends, in ms. Default 100. */
  settleMs?: number;
}

export interface WatchdogHandle {
  /** Marks matching issues in this test as expected. */
  allow(rule: MatchRule): void;
}

export const ATTACHMENT_NAME = 'watchdog-issues';
