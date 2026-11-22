import type { GroupExample, IssueGroup, WatchdogReport } from './report-types';

function firstLine(text: string, max = 110): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/`/g, "'");
}

function fence(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function headline(report: WatchdogReport): string {
  const { totals, baseline } = report;
  if (totals.groups === 0) {
    return `No browser issues found in ${plural(totals.testsScanned, 'test')}.`;
  }
  const severity = `High: ${totals.bySeverity.high} · Medium: ${totals.bySeverity.medium} · Low: ${totals.bySeverity.low}`;
  const newPart = baseline ? ` **${baseline.newGroups} new** since the baseline.` : '';
  return (
    `Found **${plural(totals.groups, 'issue group')}** (${plural(totals.occurrences, 'occurrence')}) ` +
    `in ${totals.testsWithIssues} of ${plural(totals.testsScanned, 'test')}. ${severity}.${newPart}`
  );
}

function exampleLines(example: GroupExample): string[] {
  const lines: string[] = [];
  if (example.pageUrl) lines.push(`- **Page:** ${example.pageUrl}`);
  if (example.location) {
    lines.push(`- **Source:** ${example.location.url}:${example.location.line}:${example.location.column}`);
  }
  if (example.request) {
    const r = example.request;
    const outcome = r.status !== undefined ? String(r.status) : (r.failure ?? '');
    lines.push(`- **Request:** ${r.method} ${r.url} → ${outcome} (${r.resourceType})`);
    if (r.bodySnippet) lines.push(`- **Response body:**\n\n${fence(r.bodySnippet)}\n`);
  }
  if (example.stack) lines.push(`- **Stack:**\n\n${fence(example.stack)}\n`);
  return lines;
}

function groupDetails(group: IssueGroup): string {
  const lines = [
    `<details><summary><b>${group.severity} · ${group.category}</b> — ${cell(firstLine(group.message, 90))}</summary>`,
    '',
    `- **Fingerprint:** \`${group.fingerprint}\`${group.isNew ? ' (new)' : ''}${group.thirdParty ? ' (third-party)' : ''}`,
    `- **Seen:** ${plural(group.occurrences, 'time')} in ${plural(group.tests.length, 'test')}`,
    `- **Tests:** ${group.tests.map((t) => `${t.title} (${t.file}:${t.line})`).join('; ')}`,
  ];
  if (group.message.includes('\n') || group.message.length > 90) lines.push(`- **Message:**\n\n${fence(group.message)}\n`);
  if (group.examples[0]) lines.push(...exampleLines(group.examples[0]));
  if (group.triage) {
    const t = group.triage;
    lines.push(
      `- **AI triage:** ${t.verdict}, ${t.severity} — ${t.title}`,
      `  - Likely cause: ${t.likelyCause}`,
      `  - Suggested fix: ${t.suggestedFix}`,
      `  - Owner: ${t.owner}`,
    );
  }
  lines.push('', '</details>');
  return lines.join('\n');
}

export function renderMarkdown(report: WatchdogReport, maxDetails = 25): string {
  const out: string[] = ['## Playwright Sentinel', '', headline(report), ''];

  if (report.failOnNew?.triggered) {
    out.push(
      `> **Run failed by the watchdog:** ${plural(report.failOnNew.offending.length, 'new issue group')} ` +
        `at "${report.failOnNew.threshold}" severity or above.`,
      '',
    );
  }
  if (report.ai?.status === 'ok' && report.ai.summary) {
    out.push('### AI triage', '', report.ai.summary, '');
  } else if (report.ai && report.ai.status !== 'ok') {
    out.push(`_AI triage ${report.ai.status}: ${report.ai.detail ?? 'no details'}_`, '');
  }
  if (report.groups.length === 0) return `${out.join('\n')}\n`;

  const hasBaseline = report.baseline !== null;
  const hasTriage = report.groups.some((g) => g.triage);
  const header = ['Severity', 'Category', 'Issue', 'Tests', 'Seen'];
  if (hasBaseline) header.unshift('New');
  if (hasTriage) header.push('AI verdict');
  out.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
  for (const group of report.groups) {
    const row = [
      group.severity,
      group.category,
      `\`${cell(firstLine(group.message))}\`${group.thirdParty ? ' (3rd party)' : ''}`,
      String(group.tests.length),
      String(group.occurrences),
    ];
    if (hasBaseline) row.unshift(group.isNew ? '**new**' : '');
    if (hasTriage) row.push(group.triage?.verdict ?? '');
    out.push(`| ${row.join(' | ')} |`);
  }

  out.push('', '### Details', '');
  for (const group of report.groups.slice(0, maxDetails)) out.push(groupDetails(group), '');
  if (report.groups.length > maxDetails) {
    out.push(`_${report.groups.length - maxDetails} more groups are in watchdog-report.json and index.html._`, '');
  }
  if (report.baseline?.notSeen.length) {
    out.push(
      `_${plural(report.baseline.notSeen.length, 'baseline issue')} did not show up in this run (fixed, or not covered by the tests that ran)._`,
      '',
    );
  }
  return `${out.join('\n')}\n`;
}

export function renderHtml(report: WatchdogReport): string {
  const data = JSON.stringify(report).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel report</title>
<style>
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --border: #e3e2dd;
  --high: #c0392b; --high-bg: #fbeae8; --medium: #b9770e; --medium-bg: #fdf3e1; --low: #5d6d7e; --low-bg: #eef1f4;
  --new: #6c3fc5; --new-bg: #f0eafb; --accent: #2c5fa8; --code-bg: #f1f0ec;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a09f98; --border: #33322f;
    --high: #f08a7e; --high-bg: #3a1f1c; --medium: #f0c060; --medium-bg: #3a2f18; --low: #a9b6c4; --low-bg: #262b31;
    --new: #b79cf2; --new-bg: #2c2440; --accent: #8fb3ec; --code-bg: #262624;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.stat b { display: block; font-size: 22px; }
.stat span { color: var(--muted); font-size: 13px; }
.banner { border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; border: 1px solid var(--border); background: var(--surface); }
.banner.fail { border-color: var(--high); background: var(--high-bg); }
.banner h2 { font-size: 14px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin: 18px 0 12px; font-size: 14px; }
.controls input[type=search], .controls select { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
.controls input[type=search] { flex: 1 1 220px; min-width: 0; }
.controls label { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.group { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; }
.group > summary { list-style: none; cursor: pointer; padding: 12px 14px; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: start; }
.group > summary::-webkit-details-marker { display: none; }
.group[open] > summary { border-bottom: 1px solid var(--border); }
.msg { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.meta { grid-column: 2 / 4; color: var(--muted); font-size: 13px; }
.count { color: var(--muted); font-size: 13px; white-space: nowrap; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; }
.badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
.sev-high { color: var(--high); background: var(--high-bg); }
.sev-medium { color: var(--medium); background: var(--medium-bg); }
.sev-low { color: var(--low); background: var(--low-bg); }
.b-new { color: var(--new); background: var(--new-bg); }
.b-plain { color: var(--muted); background: var(--code-bg); }
.body { padding: 12px 14px 14px; font-size: 14px; }
.body dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; }
.body dt { color: var(--muted); }
.body dd { margin: 0; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: 10px 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.triage { margin-top: 12px; padding: 10px 12px; border-left: 3px solid var(--accent); background: var(--code-bg); border-radius: 0 8px 8px 0; }
.triage p { margin: 4px 0; }
a { color: var(--accent); }
.empty { color: var(--muted); padding: 30px 0; text-align: center; }
@media (max-width: 600px) {
  .group > summary { grid-template-columns: 1fr; }
  .meta { grid-column: auto; }
  .body dl { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main>
  <h1>Playwright Sentinel</h1>
  <div class="sub" id="sub"></div>
  <div class="stats" id="stats"></div>
  <div id="banners"></div>
  <div class="controls">
    <input type="search" id="q" placeholder="Search messages, URLs, tests" aria-label="Search">
    <select id="sev" aria-label="Severity"><option value="">All severities</option><option value="high">High</option><option value="medium">Medium and up</option></select>
    <select id="cat" aria-label="Category"><option value="">All categories</option></select>
    <label id="newWrap"><input type="checkbox" id="onlyNew"> New only</label>
    <label><input type="checkbox" id="hide3p"> Hide third-party</label>
  </div>
  <div id="list"></div>
</main>
<script type="application/json" id="report-data">${data}</script>
<script>
(function () {
  var report = JSON.parse(document.getElementById('report-data').textContent);
  var rank = { low: 1, medium: 2, high: 3 };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  var t = report.totals;
  var gateFailed = report.failOnNew && report.failOnNew.triggered;
  document.getElementById('sub').textContent = 'Generated ' + new Date(report.generatedAt).toLocaleString() +
    ' · tests ' + report.runStatus + (gateFailed ? ', run failed by the watchdog' : '') +
    ' · ' + plural(t.testsScanned, 'test') + ' scanned';
  var groupsById = {};
  report.groups.forEach(function (g) { groupsById[g.fingerprint] = g; });

  var stats = [
    [t.groups, 'issue groups'], [t.occurrences, 'occurrences'],
    [t.testsWithIssues + ' / ' + t.testsScanned, 'tests with issues'],
    [t.bySeverity.high, 'high severity']
  ];
  if (report.baseline) stats.push([report.baseline.newGroups, 'new since baseline']);
  stats.push([t.ignored + t.allowed, 'ignored or allowed']);
  var statsEl = document.getElementById('stats');
  stats.forEach(function (s) { var box = el('div', 'stat'); box.appendChild(el('b', null, s[0])); box.appendChild(el('span', null, s[1])); statsEl.appendChild(box); });

  var banners = document.getElementById('banners');
  if (report.failOnNew && report.failOnNew.triggered) {
    var fail = el('div', 'banner fail');
    fail.appendChild(el('h2', null, 'Run failed by the watchdog'));
    fail.appendChild(el('div', null, plural(report.failOnNew.offending.length, 'new issue group') + ' at "' + report.failOnNew.threshold + '" severity or above.'));
    banners.appendChild(fail);
  }
  if (report.ai) {
    var ai = el('div', 'banner');
    ai.appendChild(el('h2', null, 'AI triage' + (report.ai.model ? ' · ' + report.ai.model : '') + (report.ai.provider === 'claude-code' ? ' via Claude Code' : '')));
    ai.appendChild(el('div', null, report.ai.status === 'ok' ? report.ai.summary : 'Triage ' + report.ai.status + ': ' + (report.ai.detail || '')));
    banners.appendChild(ai);
  }
  if (!report.baseline) document.getElementById('newWrap').style.display = 'none';

  var catSelect = document.getElementById('cat');
  Object.keys(t.byCategory).forEach(function (c) { var o = el('option', null, c + ' (' + t.byCategory[c] + ')'); o.value = c; catSelect.appendChild(o); });

  function row(dl, label, value, pre) {
    if (value === undefined || value === null || value === '') return;
    dl.appendChild(el('dt', null, label));
    var dd = el('dd');
    if (pre) dd.appendChild(el('pre', null, value)); else dd.textContent = value;
    dl.appendChild(dd);
  }

  function renderGroup(g) {
    var d = el('details', 'group');
    d.id = 'g-' + g.fingerprint;
    var s = el('summary');
    var badges = el('div', 'badges');
    badges.appendChild(el('span', 'badge sev-' + g.severity, g.severity));
    if (g.isNew) badges.appendChild(el('span', 'badge b-new', 'new'));
    s.appendChild(badges);
    s.appendChild(el('div', 'msg', g.message.split('\\n')[0]));
    s.appendChild(el('div', 'count', plural(g.occurrences, 'time')));
    var meta = g.category + ' · ' + plural(g.tests.length, 'test') + (g.thirdParty ? ' · third-party' : '') +
      (g.triage ? ' · AI: ' + g.triage.verdict : '');
    s.appendChild(el('div', 'meta', meta));
    d.appendChild(s);

    var body = el('div', 'body');
    var dl = el('dl');
    row(dl, 'Fingerprint', g.fingerprint);
    if (g.message.indexOf('\\n') !== -1 || g.message.length > 120) row(dl, 'Message', g.message, true);
    row(dl, 'Tests', g.tests.map(function (x) { return x.title + ' (' + x.file + ':' + x.line + ', ' + x.status + ')'; }).join('\\n'), true);
    g.examples.forEach(function (ex, i) {
      var suffix = g.examples.length > 1 ? ' ' + (i + 1) : '';
      row(dl, 'Page' + suffix, ex.pageUrl);
      if (ex.location) row(dl, 'Source' + suffix, ex.location.url + ':' + ex.location.line + ':' + ex.location.column);
      if (ex.request) {
        var r = ex.request;
        row(dl, 'Request' + suffix, r.method + ' ' + r.url + ' → ' + (r.status !== undefined ? r.status : r.failure) + ' (' + r.resourceType + ')');
        row(dl, 'Response body' + suffix, r.bodySnippet, true);
      }
      row(dl, 'Stack' + suffix, ex.stack, true);
    });
    body.appendChild(dl);

    if (g.coOccursWith.length) {
      body.appendChild(el('p', null, 'Seen in the same tests as:'));
      var rel = el('ul');
      g.coOccursWith.forEach(function (fp) {
        var other = groupsById[fp];
        var label = other ? other.category + ': ' + other.message.split('\\n')[0].slice(0, 90) : fp;
        var a = el('a', null, label); a.href = '#g-' + fp;
        a.addEventListener('click', function () { var target = document.getElementById('g-' + fp); if (target) target.open = true; });
        var li = el('li'); li.appendChild(a); rel.appendChild(li);
      });
      body.appendChild(rel);
    }
    if (g.triage) {
      var tr = el('div', 'triage');
      tr.appendChild(el('p', null, 'AI triage: ' + g.triage.verdict + ', ' + g.triage.severity + ' · owner: ' + g.triage.owner));
      tr.appendChild(el('p', null, g.triage.title)).style.fontWeight = '600';
      tr.appendChild(el('p', null, 'Likely cause: ' + g.triage.likelyCause));
      tr.appendChild(el('p', null, 'Suggested fix: ' + g.triage.suggestedFix));
      body.appendChild(tr);
    }
    d.appendChild(body);
    return d;
  }

  var list = document.getElementById('list');
  var nodes = report.groups.map(function (g) {
    var haystack = [g.message, g.category, g.fingerprint].concat(g.tests.map(function (x) { return x.title + ' ' + x.file; }))
      .concat(g.examples.map(function (e) { return (e.pageUrl || '') + ' ' + (e.request ? e.request.url : '') + ' ' + (e.location ? e.location.url : ''); }))
      .join(' ').toLowerCase();
    var node = renderGroup(g);
    list.appendChild(node);
    return { g: g, node: node, haystack: haystack };
  });
  var empty = el('div', 'empty', report.groups.length ? 'No issues match these filters.' : 'No browser issues found.');
  list.appendChild(empty);

  function apply() {
    var q = document.getElementById('q').value.trim().toLowerCase();
    var sev = document.getElementById('sev').value;
    var cat = catSelect.value;
    var onlyNew = document.getElementById('onlyNew').checked;
    var hide3p = document.getElementById('hide3p').checked;
    var shown = 0;
    nodes.forEach(function (n) {
      var ok = (!q || n.haystack.indexOf(q) !== -1) && (!sev || rank[n.g.severity] >= rank[sev]) &&
        (!cat || n.g.category === cat) && (!onlyNew || n.g.isNew) && (!hide3p || !n.g.thirdParty);
      n.node.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    empty.style.display = shown ? 'none' : '';
  }
  ['q', 'sev', 'cat', 'onlyNew', 'hide3p'].forEach(function (id) {
    var node = document.getElementById(id);
    node.addEventListener(node.type === 'search' ? 'input' : 'change', apply);
  });
  apply();
})();
</script>
</body>
</html>
`;
}
