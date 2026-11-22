import { createHash } from 'node:crypto';
import type { Category, MatchRule, Severity, SourceLocation } from './types';

export const DEFAULT_SEVERITY: Record<Category, Severity> = {
  'uncaught-exception': 'high',
  'unhandled-rejection': 'high',
  'http-5xx': 'high',
  'graphql-error': 'high',
  hydration: 'medium',
  'console-error': 'medium',
  cors: 'medium',
  csp: 'medium',
  'mixed-content': 'medium',
  'request-failed': 'medium',
  'http-4xx': 'medium',
  'framework-warning': 'low',
  'console-warning': 'low',
};

export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/** Third-party issues rank one level lower; they're usually not yours to fix. */
export function downgrade(severity: Severity): Severity {
  return severity === 'high' ? 'medium' : 'low';
}

export const DEFAULT_IGNORES: MatchRule[] = [
  {
    category: 'http-4xx',
    url: /\/favicon\.ico(?:[?#]|$)/,
    reason: 'Browsers request /favicon.ico on their own',
  },
  {
    category: 'request-failed',
    message: /ERR_ABORTED|NS_BINDING_ABORTED|: cancelled$|Load request cancelled/i,
    reason: 'Requests cancelled because the page navigated away',
  },
  {
    url: /^(?:chrome|moz|safari-web)-extension:\/\//,
    reason: 'Errors from browser extensions',
  },
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi;
const NUMBER = /\b\d+(?:\.\d+)?\b/g;
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s'"`<>()]+/g;

function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^(?=[0-9a-f]*\d)[0-9a-f]{12,}$/i.test(segment)) return true;
  return segment.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment);
}

/** Build hashes in file names (app.9f8e7d6c5b.js) change on every deploy. */
const HASH_IN_FILE_NAME = /(?<=[.\-_])(?=[0-9a-f]*\d)[0-9a-f]{8,}(?=[.\-_]|$)/gi;

/** Origin and path, with ids as `:id`, build hashes as `<hash>`, and no query or fragment. */
export function normalizeUrl(raw: string): string {
  if (raw.startsWith('data:')) return 'data:…';
  try {
    const url = new URL(raw);
    const path = url.pathname
      .split('/')
      .map((segment) => (isIdSegment(segment) ? ':id' : segment.replace(HASH_IN_FILE_NAME, '<hash>')))
      .join('/');
    return `${url.origin}${path}`;
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

/** Strips what changes between runs, so repeats of a problem share a fingerprint. */
export function normalizeMessage(text: string): string {
  return text
    .replace(URL_IN_TEXT, (match) => normalizeUrl(match.replace(/[.,;:]+$/, '')))
    .replace(UUID, '<uuid>')
    .replace(LONG_HEX, '<hex>')
    .replace(/:\d+:\d+\b/g, '')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Masks tokens, passwords and email addresses. */
export function redact(text: string): string {
  return text
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>')
    .replace(/\b(Bearer|Basic)\s+[\w\-.~+/=]+/gi, '$1 <redacted>')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
      '$1<redacted>',
    )
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>');
}

export function fingerprintOf(category: Category, key: string): string {
  return createHash('sha1').update(`${category}\n${key}`).digest('hex').slice(0, 12);
}

const DUPLICATE_OF_NETWORK_EVENT = /^Failed to load resource:/;
const CORS =
  /blocked by CORS policy|Cross-Origin Request Blocked|CORS request did not succeed|not allowed by Access-Control-Allow-Origin|due to access control checks/i;
const CSP = /Content[- ]Security[- ]Policy/i;
const MIXED_CONTENT = /Mixed Content/i;
const HYDRATION =
  /hydrat|did not match\. server|server-rendered (?:html|text)|text content does not match|Minified React error #(?:418|419|421|422|423|425)\b/i;
const FRAMEWORK_WARNING = /^Warning: |^\[Vue warn\]|\bNG0\d{3,4}\b|^\[svelte\]/i;

/**
 * Returns null for messages not worth recording. "Failed to load resource" lines are skipped because
 * the network listener records the same failure with more detail.
 */
export function classifyConsole(type: string, text: string): Category | null {
  if (DUPLICATE_OF_NETWORK_EVENT.test(text)) return null;
  const isError = type === 'error' || type === 'assert';
  if (!isError && type !== 'warning') return null;
  if (CORS.test(text)) return 'cors';
  if (CSP.test(text)) return 'csp';
  if (MIXED_CONTENT.test(text)) return 'mixed-content';
  if (HYDRATION.test(text)) return 'hydration';
  if (FRAMEWORK_WARNING.test(text)) return 'framework-warning';
  return isError ? 'console-error' : 'console-warning';
}

export function isCorsMessage(text: string): boolean {
  return CORS.test(text);
}

/** Firefox wraps some console errors as `[JavaScript Error: "..." {file: ...}]`. */
export function unwrapConsoleText(text: string): string {
  const match = /^\[JavaScript (?:Error|Warning): "([\s\S]*)"(?: \{[^}]*\})?\]$/.exec(text);
  return match ? match[1] : text;
}

const STACK_FRAME = /((?:https?|file|webpack|chrome-extension|moz-extension|safari-web-extension):\/\/[^\s)]+?):(\d+):(\d+)/;

/** First stack frame that points at a URL. */
export function parseTopFrame(stack: string): SourceLocation | undefined {
  for (const line of stack.split('\n')) {
    const match = STACK_FRAME.exec(line);
    if (match) return { url: match[1], line: Number(match[2]), column: Number(match[3]) };
  }
  return undefined;
}

export function originOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function isThirdParty(url: string, firstPartyOrigins: ReadonlySet<string>): boolean {
  const origin = originOf(url);
  return origin !== undefined && !firstPartyOrigins.has(origin);
}

function testPattern(pattern: string | RegExp, value: string): boolean {
  if (typeof pattern === 'string') return value.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export interface RuleTarget {
  category: Category;
  message: string;
  /** Request URL and script URL, when known. */
  sourceUrls: string[];
  pageUrl?: string;
}

/** A rule matches when all its conditions match. An empty rule matches nothing. */
export function matchesRule(rule: MatchRule, target: RuleTarget): boolean {
  if (rule.category === undefined && rule.message === undefined && rule.url === undefined && rule.pageUrl === undefined) {
    return false;
  }
  if (rule.category !== undefined) {
    const categories = Array.isArray(rule.category) ? rule.category : [rule.category];
    if (!categories.includes(target.category)) return false;
  }
  if (rule.message !== undefined && !testPattern(rule.message, target.message)) return false;
  const urlPattern = rule.url;
  if (urlPattern !== undefined && !target.sourceUrls.some((url) => testPattern(urlPattern, url))) return false;
  if (rule.pageUrl !== undefined && (target.pageUrl === undefined || !testPattern(rule.pageUrl, target.pageUrl))) {
    return false;
  }
  return true;
}
