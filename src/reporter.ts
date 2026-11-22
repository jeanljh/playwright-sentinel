import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { GroupAggregator, compareGroups } from './aggregate';
import { readBaseline, writeBaseline } from './baseline';
import { SEVERITY_RANK } from './classify';
import { renderHtml, renderMarkdown } from './render';
import type { IssueGroup, WatchdogReport, WatchdogReporterOptions } from './report-types';
import { resolveProvider, triageGroups, type TriageOptions } from './triage';
import { ATTACHMENT_NAME, type Severity, type TestCaptureResult } from './types';

const LOG_PREFIX = '[watchdog]';

function testTitle(test: TestCase): string {
  const titles = [test.title];
  for (let suite: Suite | undefined = test.parent; suite && suite.type === 'describe'; suite = suite.parent) {
    titles.unshift(suite.title);
  }
  return titles.join(' › ');
}

function envFlag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

class WatchdogReporter implements Reporter {
  private readonly aggregator = new GroupAggregator();
  private configDir = process.cwd();
  private startedAt = Date.now();
  private readonly problems: string[] = [];

  constructor(private readonly options: WatchdogReporterOptions = {}) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.configDir = config.configFile ? path.dirname(config.configFile) : process.cwd();
    this.startedAt = Date.now();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find((a) => a.name === ATTACHMENT_NAME);
    if (!attachment) return;
    let capture: TestCaptureResult;
    try {
      const raw = attachment.body ?? (attachment.path ? fs.readFileSync(attachment.path) : undefined);
      if (!raw) return;
      capture = JSON.parse(raw.toString('utf8')) as TestCaptureResult;
    } catch (error) {
      this.problems.push(`could not read issues for "${test.title}": ${(error as Error).message}`);
      return;
    }
    this.aggregator.add(
      {
        id: test.id,
        title: testTitle(test),
        file: path.relative(this.configDir, test.location.file).split(path.sep).join('/'),
        line: test.location.line,
        project: test.parent.project()?.name ?? '',
        status: result.status,
      },
      capture,
    );
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const groups = this.aggregator.build();
    const report: WatchdogReport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      runStatus: result.status,
      durationMs: Date.now() - this.startedAt,
      totals: {
        groups: groups.length,
        occurrences: groups.reduce((sum, g) => sum + g.occurrences, 0),
        testsScanned: this.aggregator.testsScanned,
        testsWithIssues: this.aggregator.testsWithIssues,
        ignored: this.aggregator.ignored,
        allowed: this.aggregator.allowed,
        bySeverity: { high: 0, medium: 0, low: 0 },
        byCategory: {},
      },
      baseline: null,
      failOnNew: null,
      ai: null,
      groups,
    };
    for (const group of groups) {
      report.totals.bySeverity[group.severity]++;
      report.totals.byCategory[group.category] = (report.totals.byCategory[group.category] ?? 0) + 1;
    }

    this.applyBaseline(report);
    this.applyFailOnNew(report);
    await this.applyTriage(report);

    const outputDir = path.resolve(this.configDir, this.options.outputDir ?? 'watchdog-report');
    const markdown = renderMarkdown(report);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'watchdog-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'watchdog-report.md'), markdown);
    fs.writeFileSync(path.join(outputDir, 'index.html'), renderHtml(report));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

    this.printSummary(report, outputDir);

    if (report.failOnNew?.triggered && result.status === 'passed') return { status: 'failed' };
    return undefined;
  }

  private applyBaseline(report: WatchdogReport): void {
    if (!this.options.baselineFile) return;
    const file = path.resolve(this.configDir, this.options.baselineFile);
    let known = new Set<string>();
    let found = false;
    try {
      const baseline = readBaseline(file);
      if (baseline) {
        known = new Set(Object.keys(baseline.issues));
        found = true;
      }
    } catch (error) {
      this.problems.push((error as Error).message);
    }
    const seen = new Set(report.groups.map((g) => g.fingerprint));
    for (const group of report.groups) group.isNew = !known.has(group.fingerprint);
    report.groups.sort(compareGroups);

    const update = envFlag('WATCHDOG_UPDATE_BASELINE') ?? this.options.updateBaseline ?? false;
    if (update) writeBaseline(file, report.groups);
    const newGroups = report.groups.filter((g) => g.isNew).length;
    report.baseline = {
      file: path.relative(this.configDir, file).split(path.sep).join('/'),
      found,
      newGroups,
      knownGroups: report.groups.length - newGroups,
      notSeen: [...known].filter((fingerprint) => !seen.has(fingerprint)),
      updated: update,
    };
  }

  private applyFailOnNew(report: WatchdogReport): void {
    const threshold = this.options.failOnNew ?? 'none';
    if (threshold === 'none') return;
    const offending = report.groups
      .filter((g) => g.isNew !== false && SEVERITY_RANK[g.severity] >= SEVERITY_RANK[threshold as Severity])
      .map((g) => g.fingerprint);
    report.failOnNew = {
      threshold,
      offending,
      triggered: offending.length > 0 && !report.baseline?.updated,
    };
  }

  private async applyTriage(report: WatchdogReport): Promise<void> {
    const enabled = envFlag('WATCHDOG_AI') ?? this.options.ai?.enabled ?? false;
    if (!enabled) return;
    const options: TriageOptions = { ...this.options.ai };
    options.provider = resolveProvider(options);
    const via = options.provider === 'claude-code' ? 'Claude Code' : 'the Anthropic API';
    process.stdout.write(
      `${LOG_PREFIX} Triaging ${Math.min(report.groups.length, options.maxGroups ?? 30)} issue groups with Claude via ${via}…\n`,
    );
    report.ai = await triageGroups(report.groups, options);
  }

  private printSummary(report: WatchdogReport, outputDir: string): void {
    const { totals } = report;
    const lines: string[] = [''];
    if (totals.groups === 0) {
      lines.push(`${LOG_PREFIX} No browser issues found in ${totals.testsScanned} test(s).`);
    } else {
      const newPart = report.baseline ? `, ${report.baseline.newGroups} new since the baseline` : '';
      lines.push(
        `${LOG_PREFIX} ${totals.groups} issue group(s), ${totals.occurrences} occurrence(s) in ${totals.testsWithIssues} of ` +
          `${totals.testsScanned} test(s): ${totals.bySeverity.high} high, ${totals.bySeverity.medium} medium, ` +
          `${totals.bySeverity.low} low${newPart}.`,
      );
      const top = report.groups.slice(0, this.options.printTop ?? 10);
      for (const group of top) lines.push(`  ${this.formatGroupLine(group)}`);
      if (report.groups.length > top.length) lines.push(`  … and ${report.groups.length - top.length} more`);
    }
    if (report.ai) {
      lines.push(
        report.ai.status === 'ok'
          ? `${LOG_PREFIX} AI triage (${report.ai.model}${report.ai.provider === 'claude-code' ? ' via Claude Code' : ''}): ${report.ai.summary}`
          : `${LOG_PREFIX} AI triage ${report.ai.status}: ${report.ai.detail}`,
      );
    }
    if (report.baseline?.updated) lines.push(`${LOG_PREFIX} Baseline updated: ${report.baseline.file}`);
    if (report.failOnNew?.triggered) {
      lines.push(
        `${LOG_PREFIX} Failing the run: ${report.failOnNew.offending.length} new issue group(s) at "${report.failOnNew.threshold}" or above.`,
      );
    }
    for (const problem of this.problems) lines.push(`${LOG_PREFIX} Warning: ${problem}`);
    const relative = path.relative(process.cwd(), path.join(outputDir, 'index.html')) || 'index.html';
    lines.push(`${LOG_PREFIX} Report: ${relative}`, '');
    process.stdout.write(lines.join('\n'));
  }

  private formatGroupLine(group: IssueGroup): string {
    const message = group.message.split('\n')[0];
    const shortMessage = message.length > 90 ? `${message.slice(0, 89)}…` : message;
    const flags = [group.isNew ? 'NEW' : '', group.thirdParty ? '3rd-party' : '', group.triage ? `AI: ${group.triage.verdict}` : '']
      .filter(Boolean)
      .join(', ');
    return (
      `${group.severity.toUpperCase().padEnd(6)} ${group.category.padEnd(19)} ${shortMessage} ` +
      `(${group.tests.length} test${group.tests.length === 1 ? '' : 's'}, ${group.occurrences}x)${flags ? ` [${flags}]` : ''}`
    );
  }
}

export default WatchdogReporter;
