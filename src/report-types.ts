import type { Category, RequestInfo, Severity, SourceLocation } from './types';

export type TriageEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** 'api' uses an API key; 'claude-code' uses the Claude Code CLI login. */
export type TriageProvider = 'api' | 'claude-code';

export interface WatchdogReporterOptions {
  /** Where reports are written. Default 'watchdog-report'. */
  outputDir?: string;
  /** Known issues. Anything not in this file is marked new. */
  baselineFile?: string;
  /** Rewrite the baseline from this run. Also set by WATCHDOG_UPDATE_BASELINE=1. */
  updateBaseline?: boolean;
  /** Fail the run when a new issue at or above this severity appears, even if all tests passed. Default 'none'. */
  failOnNew?: Severity | 'none';
  /** Claude triage. Also enabled by WATCHDOG_AI=1. */
  ai?: {
    enabled?: boolean;
    /** Default 'claude-opus-5-5'. */
    model?: string;
    /** How many of the most severe groups to send. Default 30. */
    maxGroups?: number;
    /** Default 'medium'. */
    effort?: TriageEffort;
    /** 'auto' (default) uses the API when ANTHROPIC_API_KEY is set, otherwise Claude Code if installed. */
    provider?: TriageProvider | 'auto';
    /** Claude Code CLI path. Default: `claude` on PATH. */
    claudePath?: string;
    /** Claude Code timeout in ms. Default 5 minutes. */
    timeoutMs?: number;
  };
  /** Groups printed to the terminal. Default 10. */
  printTop?: number;
}

export interface GroupTest {
  id: string;
  title: string;
  file: string;
  line: number;
  project: string;
  status: string;
}

export interface GroupExample {
  pageUrl?: string;
  location?: SourceLocation;
  stack?: string;
  request?: RequestInfo;
}

export type TriageVerdict = 'bug' | 'needs-investigation' | 'noise';
export type TriageOwner = 'frontend' | 'backend' | 'third-party' | 'test-environment' | 'unknown';

export interface GroupTriage {
  verdict: TriageVerdict;
  severity: Severity;
  title: string;
  likelyCause: string;
  suggestedFix: string;
  owner: TriageOwner;
  relatedFingerprints: string[];
}

export interface IssueGroup {
  fingerprint: string;
  category: Category;
  severity: Severity;
  message: string;
  normalized: string;
  occurrences: number;
  thirdParty: boolean;
  /** null when no baseline is configured. */
  isNew: boolean | null;
  tests: GroupTest[];
  examples: GroupExample[];
  /** Groups seen in the same tests; often a cause or effect of this one. */
  coOccursWith: string[];
  triage?: GroupTriage;
}

export interface AiTriageStatus {
  status: 'ok' | 'skipped' | 'failed';
  provider?: TriageProvider;
  model?: string;
  summary?: string;
  detail?: string;
  triagedGroups?: number;
}

export interface WatchdogReport {
  version: 1;
  generatedAt: string;
  runStatus: string;
  durationMs: number;
  totals: {
    groups: number;
    occurrences: number;
    testsScanned: number;
    testsWithIssues: number;
    ignored: number;
    allowed: number;
    bySeverity: Record<Severity, number>;
    byCategory: Partial<Record<Category, number>>;
  };
  baseline: {
    file: string;
    found: boolean;
    newGroups: number;
    knownGroups: number;
    /** Baseline fingerprints that did not appear in this run. */
    notSeen: string[];
    updated: boolean;
  } | null;
  failOnNew: { threshold: Severity; triggered: boolean; offending: string[] } | null;
  ai: AiTriageStatus | null;
  groups: IssueGroup[];
}
