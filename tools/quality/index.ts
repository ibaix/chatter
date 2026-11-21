// Prints the coverage of `npm run coverage` as Markdown tables. Run `npm run coverage` first.
//
//   npm run coverage:summary                  coverage of each workspace and tool
//   npm run coverage:changed                  coverage of the lines that this branch changes (base: origin/main)
//   npm run coverage:changed -- --base main   the same, with a different base
//
// The output is for people and for the review skills. It never fails on a low number.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  areaTable,
  baseFrom,
  changedLineCoverage,
  changedLinesFromDiff,
  changeTable,
  coverageByArea,
  lineHitsFromLcov,
  type CoverageSummary,
} from './coverage';

const root = process.cwd();
const reports = join(root, 'coverage');

function readReport(name: string): string {
  const path = join(reports, name);
  if (!existsSync(path)) {
    console.error(`${path} does not exist. Run "npm run coverage" first.`);
    process.exit(1);
  }
  return readFileSync(path, 'utf8');
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'summary') {
  const summary = JSON.parse(readReport('coverage-summary.json')) as CoverageSummary;
  console.log(areaTable(coverageByArea(summary, root)));
} else if (command === 'changed') {
  let base: string;
  try {
    base = baseFrom(rest);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  // Compare with the working tree, so that changes that are not committed also count
  const changed = changedLinesFromDiff(git('diff', '--unified=0', '--no-color', '--no-renames', mergeBase));
  const hits = lineHitsFromLcov(readReport('lcov.info'), root);
  // git diff leaves out new files that are not added yet. Each of their lines is a changed line.
  // Only files in the coverage report count. The list can also hold folders, such as other git checkouts.
  for (const file of git('ls-files', '--others', '--exclude-standard').split('\n').filter(f => hits.has(f))) {
    const lineCount = readFileSync(join(root, file), 'utf8').split('\n').length;
    changed.set(file, Array.from({ length: lineCount }, (_, i) => i + 1));
  }
  console.log(changeTable(changedLineCoverage(changed, hits)));
} else {
  console.error('Use "summary" or "changed [--base <git ref>]".');
  process.exit(1);
}
