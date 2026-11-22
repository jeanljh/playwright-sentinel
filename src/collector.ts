import type { BrowserContext, ConsoleMessage, Page, Request, Response, WebError } from '@playwright/test';
import {
  DEFAULT_IGNORES,
  DEFAULT_SEVERITY,
  classifyConsole,
  downgrade,
  fingerprintOf,
  isCorsMessage,
  isThirdParty,
  matchesRule,
  normalizeMessage,
  normalizeUrl,
  originOf,
  parseTopFrame,
  redact,
  unwrapConsoleText,
} from './classify';
import type {
  CapturedIssue,
  Category,
  MatchRule,
  RequestInfo,
  SourceLocation,
  TestCaptureResult,
  WatchdogHandle,
  WatchdogOptions,
} from './types';

const REJECTION_MARKER = '__WATCHDOG_UNHANDLED_REJECTION__';

// Playwright reports unhandled rejections as uncaught exceptions. This page script logs a marker
// for each rejection so the two can be told apart.
const REJECTION_TRACKER = `(() => {
  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason;
      const text = reason instanceof Error ? reason.message
        : typeof reason === 'string' ? reason : JSON.stringify(reason);
      console.debug(${JSON.stringify(REJECTION_MARKER)} + String(text));
    } catch (_) {}
  });
})();`;

const NETWORK_CATEGORIES: ReadonlySet<Category> = new Set(['http-4xx', 'http-5xx', 'request-failed']);
const MAX_STACK_LINES = 15;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_BODY_BYTES = 1_000_000;

interface Occurrence {
  category: Category;
  message: string;
  atMs: number;
  pageUrl?: string;
  location?: SourceLocation;
  stack?: string;
  request?: RequestInfo;
  /** Raw message, matched against rejection markers. */
  errorMessage?: string;
}

function pageUrlOf(page: Page | null | undefined): string | undefined {
  try {
    return page?.url() || undefined;
  } catch {
    return undefined;
  }
}

function pageUrlOfRequest(request: Request): string | undefined {
  try {
    const frame = request.frame();
    return pageUrlOf(frame.page()) ?? frame.url();
  } catch {
    return undefined;
  }
}

function isApiCall(request: Request): boolean {
  const type = request.resourceType();
  return type === 'fetch' || type === 'xhr';
}

function looksLikeGraphQL(request: Request): boolean {
  if (/graphql/i.test(request.url())) return true;
  const body = request.postData();
  return body !== null && /"query"\s*:\s*"[^"]*[{(]/.test(body);
}

export class IssueCollector {
  private occurrences: Occurrence[] = [];
  private readonly rejectionMarkers: string[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly allowRules: MatchRule[] = [];
  private readonly requestsWithErrorStatus = new WeakSet<Request>();
  private readonly detachers: Array<() => void> = [];
  private readonly startedAt = Date.now();
  private finalized = false;

  /** What tests get as the `watchdog` fixture. */
  readonly handle: WatchdogHandle = {
    allow: (rule) => {
      this.allowRules.push(rule);
    },
  };

  constructor(
    private readonly options: WatchdogOptions = {},
    private readonly baseURL?: string,
  ) {}

  async attach(context: BrowserContext): Promise<void> {
    await context.addInitScript(REJECTION_TRACKER);

    const onConsole = (message: ConsoleMessage) => this.onConsole(message);
    const onWebError = (error: WebError) => this.onWebError(error);
    const onResponse = (response: Response) => this.onResponse(response);
    const onRequestFailed = (request: Request) => this.onRequestFailed(request);

    context.on('console', onConsole);
    context.on('weberror', onWebError);
    context.on('response', onResponse);
    context.on('requestfailed', onRequestFailed);
    this.detachers.push(
      () => context.off('console', onConsole),
      () => context.off('weberror', onWebError),
      () => context.off('response', onResponse),
      () => context.off('requestfailed', onRequestFailed),
    );
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private onConsole(message: ConsoleMessage): void {
    const text = unwrapConsoleText(message.text());
    if (text.startsWith(REJECTION_MARKER)) {
      this.rejectionMarkers.push(text.slice(REJECTION_MARKER.length));
      return;
    }
    if (message.type() === 'warning' && this.options.captureWarnings === false) return;
    const category = classifyConsole(message.type(), text);
    if (!category) return;
    const location = message.location();
    this.occurrences.push({
      category,
      message: text,
      atMs: this.elapsed(),
      pageUrl: pageUrlOf(message.page()),
      location: location.url
        ? { url: location.url, line: location.lineNumber, column: location.columnNumber }
        : undefined,
    });
  }

  private onWebError(webError: WebError): void {
    const error = webError.error();
    const rawMessage = error.message || String(error);
    // WebKit also reports a fetch blocked by CORS as a page error. The console message covers it.
    if (isCorsMessage(`${error.name}: ${rawMessage}`)) return;
    const stack = error.stack ? error.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n') : undefined;

    // WebKit labels rejections itself, so they need no marker.
    if (error.name === 'Unhandled Promise Rejection') {
      this.occurrences.push({
        category: 'unhandled-rejection',
        message: rawMessage.replace(/^Error: /, ''),
        atMs: this.elapsed(),
        pageUrl: pageUrlOf(webError.page()),
        location: stack ? parseTopFrame(stack) : undefined,
        stack,
      });
      return;
    }

    // Chromium sometimes adds "Uncaught" to the name or message.
    const stripUncaught = (text: string) => text.replace(/^Uncaught (?:\(in promise\) )?/, '');
    const name = error.name && error.name !== 'Error' ? stripUncaught(error.name) : undefined;
    const shownMessage = stripUncaught(rawMessage);
    this.occurrences.push({
      category: 'uncaught-exception',
      message: name && !shownMessage.startsWith(`${name}:`) ? `${name}: ${shownMessage}` : shownMessage,
      errorMessage: rawMessage,
      atMs: this.elapsed(),
      pageUrl: pageUrlOf(webError.page()),
      location: stack ? parseTopFrame(stack) : undefined,
      stack,
    });
  }

  private onResponse(response: Response): void {
    const request = response.request();
    const status = response.status();

    if (status >= 400) {
      this.requestsWithErrorStatus.add(request);
      const occurrence: Occurrence = {
        category: status >= 500 ? 'http-5xx' : 'http-4xx',
        message: `${request.method()} ${response.url()} returned ${status} ${response.statusText()}`.trim(),
        atMs: this.elapsed(),
        pageUrl: pageUrlOfRequest(request),
        request: {
          method: request.method(),
          url: response.url(),
          resourceType: request.resourceType(),
          status,
        },
      };
      this.occurrences.push(occurrence);
      const snippetLength = this.options.bodySnippetLength ?? 600;
      if (snippetLength > 0 && isApiCall(request)) {
        this.track(
          response.text().then((body) => {
            if (body && occurrence.request) occurrence.request.bodySnippet = redact(body.slice(0, snippetLength));
          }),
        );
      }
      return;
    }

    if (this.options.detectGraphQLErrors === false || !isApiCall(request) || !looksLikeGraphQL(request)) return;
    const contentType = response.headers()['content-type'] ?? '';
    const contentLength = Number(response.headers()['content-length'] ?? 0);
    if (!contentType.includes('json') || contentLength > MAX_BODY_BYTES) return;
    const atMs = this.elapsed();
    const pageUrl = pageUrlOfRequest(request);
    this.track(
      response.json().then((body: unknown) => {
        const errors = (body as { errors?: Array<{ message?: unknown }> } | null)?.errors;
        if (!Array.isArray(errors) || errors.length === 0) return;
        const messages = errors.slice(0, 3).map((e) => String(e?.message ?? JSON.stringify(e)));
        this.occurrences.push({
          category: 'graphql-error',
          message: `GraphQL error from ${request.method()} ${response.url()}: ${messages.join('; ')}`,
          atMs,
          pageUrl,
          request: {
            method: request.method(),
            url: response.url(),
            resourceType: request.resourceType(),
            status,
            bodySnippet: redact(JSON.stringify(body).slice(0, this.options.bodySnippetLength ?? 600)),
          },
        });
      }),
    );
  }

  private onRequestFailed(request: Request): void {
    // Already recorded from its error response.
    if (this.requestsWithErrorStatus.has(request)) return;
    const failure = request.failure()?.errorText ?? 'unknown error';
    this.occurrences.push({
      category: 'request-failed',
      message: `${request.method()} ${request.url()} failed: ${failure}`,
      atMs: this.elapsed(),
      pageUrl: pageUrlOfRequest(request),
      request: {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failure,
      },
    });
  }

  /** Stops listening, waits for pending body reads and returns the grouped issues. */
  async finalize(): Promise<TestCaptureResult> {
    if (this.finalized) throw new Error('IssueCollector.finalize() was already called');
    this.finalized = true;

    const settleMs = this.options.settleMs ?? 100;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    for (const detach of this.detachers) detach();
    const deadline = new Promise((resolve) => setTimeout(resolve, 3000));
    await Promise.race([Promise.allSettled([...this.pending]), deadline]);

    this.markRejections();
    this.dropRequestFailuresExplainedByCors();
    return this.buildResult();
  }

  private markRejections(): void {
    const markers = [...this.rejectionMarkers];
    for (const occurrence of this.occurrences) {
      if (occurrence.category !== 'uncaught-exception' || occurrence.errorMessage === undefined) continue;
      const index = markers.indexOf(occurrence.errorMessage);
      if (index === -1) continue;
      occurrence.category = 'unhandled-rejection';
      markers.splice(index, 1);
    }
  }

  private dropRequestFailuresExplainedByCors(): void {
    const cors = this.occurrences.filter((o) => o.category === 'cors');
    if (cors.length === 0) return;
    this.occurrences = this.occurrences.filter((o) => {
      if (o.category !== 'request-failed' || !o.request) return true;
      const { method, url, failure } = o.request;
      if (cors.some((c) => c.message.includes(url))) return false;
      if (!isCorsMessage(failure ?? '')) return true;
      // WebKit's CORS message names the origin but not the URL, so add it.
      const unnamed = cors.find((c) => /^Origin \S+ is not allowed/.test(c.message) && !c.message.endsWith(')'));
      if (unnamed) unnamed.message += ` (${method} ${url})`;
      return false;
    });
  }

  private firstPartyOrigins(): Set<string> {
    const configured = this.options.firstPartyOrigins;
    if (configured && configured.length > 0) {
      return new Set(configured.map((o) => originOf(o) ?? o));
    }
    const origins = new Set<string>();
    const add = (url: string | undefined) => {
      const origin = url ? originOf(url) : undefined;
      if (origin) origins.add(origin);
    };
    add(this.baseURL);
    for (const occurrence of this.occurrences) add(occurrence.pageUrl);
    return origins;
  }

  private buildResult(): TestCaptureResult {
    const ignoreRules = [
      ...(this.options.useDefaultIgnores === false ? [] : DEFAULT_IGNORES),
      ...(this.options.ignore ?? []),
    ];
    const firstParty = this.firstPartyOrigins();
    const byFingerprint = new Map<string, CapturedIssue>();
    let ignored = 0;
    let allowed = 0;

    for (const occurrence of [...this.occurrences].sort((a, b) => a.atMs - b.atMs)) {
      const { category } = occurrence;
      const sourceUrl = occurrence.request?.url ?? occurrence.location?.url;
      const sourceUrls = [occurrence.request?.url, occurrence.location?.url].filter((u): u is string => Boolean(u));
      const target = { category, message: occurrence.message, sourceUrls, pageUrl: occurrence.pageUrl };
      const thirdParty = sourceUrl ? isThirdParty(sourceUrl, firstParty) : false;

      if (ignoreRules.some((rule) => matchesRule(rule, target)) || (thirdParty && this.options.ignoreThirdParty)) {
        ignored++;
        continue;
      }
      if (this.allowRules.some((rule) => matchesRule(rule, target))) {
        allowed++;
        continue;
      }

      const message = redact(occurrence.message).slice(0, MAX_MESSAGE_LENGTH);
      const normalized = normalizeMessage(message);
      // Rejections skip the location: WebKit gives them no stack, and the message alone is specific enough.
      const key = NETWORK_CATEGORIES.has(category)
        ? `${occurrence.request!.method} ${normalizeUrl(occurrence.request!.url)} ${occurrence.request!.status ?? occurrence.request!.failure}`
        : category === 'unhandled-rejection'
          ? normalized
          : `${normalized} @ ${occurrence.location ? normalizeUrl(occurrence.location.url) : ''}`;
      const fingerprint = fingerprintOf(category, key);

      const existing = byFingerprint.get(fingerprint);
      if (existing) {
        existing.count++;
        // A navigation can cut the first body read short, so take it from a later copy.
        if (existing.request && !existing.request.bodySnippet && occurrence.request?.bodySnippet) {
          existing.request.bodySnippet = occurrence.request.bodySnippet;
        }
        continue;
      }
      const baseSeverity = this.options.severityOverrides?.[category] ?? DEFAULT_SEVERITY[category];
      byFingerprint.set(fingerprint, {
        fingerprint,
        category,
        severity: thirdParty ? downgrade(baseSeverity) : baseSeverity,
        message,
        normalized,
        count: 1,
        thirdParty,
        pageUrl: occurrence.pageUrl ? redact(occurrence.pageUrl) : undefined,
        location: occurrence.location ? { ...occurrence.location, url: redact(occurrence.location.url) } : undefined,
        stack: occurrence.stack ? redact(occurrence.stack) : undefined,
        request: occurrence.request ? { ...occurrence.request, url: redact(occurrence.request.url) } : undefined,
        firstSeenMs: occurrence.atMs,
      });
    }

    return { version: 1, issues: [...byFingerprint.values()], ignored, allowed };
  }
}
