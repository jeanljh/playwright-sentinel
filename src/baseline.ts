import fs from 'node:fs';
import path from 'node:path';
import type { IssueGroup } from './report-types';
import type { Category } from './types';

export interface BaselineFile {
  version: 1;
  updatedAt: string;
  issues: Record<string, { category: Category; message: string }>;
}

/** Returns null if the file is missing; throws if it is invalid. */
export function readBaseline(file: string): BaselineFile | null {
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Watchdog baseline ${file} is not valid JSON: ${(error as Error).message}`);
  }
  const baseline = parsed as Partial<BaselineFile>;
  if (baseline.version !== 1 || typeof baseline.issues !== 'object' || baseline.issues === null) {
    throw new Error(`Watchdog baseline ${file} is not in the expected format (version 1 with an "issues" object)`);
  }
  return baseline as BaselineFile;
}

export function writeBaseline(file: string, groups: IssueGroup[]): void {
  const issues: BaselineFile['issues'] = {};
  for (const group of [...groups].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))) {
    issues[group.fingerprint] = { category: group.category, message: group.normalized };
  }
  const content: BaselineFile = { version: 1, updatedAt: new Date().toISOString(), issues };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
}
