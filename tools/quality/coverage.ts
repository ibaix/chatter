// Reads the coverage reports of `npm run coverage` (coverage/coverage-summary.json and coverage/lcov.info).
// Coverage is a signal that we watch. Nothing here fails a build.

interface Counts {
  covered: number;
  total: number;
}

interface FileCounts {
  lines: Counts;
  branches: Counts;
}

/** The form of coverage/coverage-summary.json: the key is "total" or the full path of a file. */
export type CoverageSummary = Record<string, FileCounts>;

export interface AreaCoverage {
  area: string;
  lines: Counts;
  branches: Counts;
}

export interface FileChangeCoverage {
  file: string;
  /** Changed lines that the coverage tool can measure (not comments, types or blank lines) */
  measured: number;
  covered: number;
  /** Changed lines that no test runs, as ranges such as "12-15" */
  uncovered: string[];
}

/** The workspace or tool folder of a file, for example "apps/server". */
export function areaOf(file: string): string {
  return file.split('/').slice(0, 2).join('/');
}

function relative(file: string, root: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

export function coverageByArea(summary: CoverageSummary, root: string): AreaCoverage[] {
  const areas = new Map<string, AreaCoverage>();
  for (const [file, counts] of Object.entries(summary)) {
    if (file === 'total') continue;
    const area = areaOf(relative(file, root));
    const row = areas.get(area) ?? { area, lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } };
    row.lines.covered += counts.lines.covered;
    row.lines.total += counts.lines.total;
    row.branches.covered += counts.branches.covered;
    row.branches.total += counts.branches.total;
    areas.set(area, row);
  }
  const rows = [...areas.values()].sort((a, b) => a.area.localeCompare(b.area));
  const { total } = summary;
  if (total) {
    rows.push({
      area: 'total',
      lines: { covered: total.lines.covered, total: total.lines.total },
      branches: { covered: total.branches.covered, total: total.branches.total },
    });
  }
  return rows;
}

/** The hit count of each measured line, for each file. The file paths start at the repo root. */
export function lineHitsFromLcov(lcov: string, root: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      current = new Map();
      files.set(relative(line.slice(3).trim(), root), current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNumber, hits] = line.slice(3).split(',').map(Number);
      current.set(lineNumber, hits);
    } else if (line.startsWith('end_of_record')) {
      current = undefined;
    }
  }
  return files;
}

/** The new line numbers of each file in a `git diff --unified=0`. Deleted files are left out. */
export function changedLinesFromDiff(diff: string): Map<string, number[]> {
  const files = new Map<string, number[]>();
  let current: number[] | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? undefined : [];
      if (current) files.set(target.replace(/^b\//, ''), current);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) current.push(n);
    }
  }
  for (const [file, lines] of files) {
    if (lines.length === 0) files.delete(file);
  }
  return files;
}

export function toRanges(lines: number[]): string[] {
  const ranges: string[] = [];
  let start: number | undefined;
  let end = 0;
  for (const n of lines) {
    if (start !== undefined && n === end + 1) {
      end = n;
      continue;
    }
    if (start !== undefined) ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = n;
    end = n;
  }
  if (start !== undefined) ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges;
}

export function changedLineCoverage(
  changed: Map<string, number[]>,
  hits: Map<string, Map<number, number>>,
): FileChangeCoverage[] {
  const rows: FileChangeCoverage[] = [];
  for (const [file, lines] of changed) {
    const fileHits = hits.get(file);
    if (!fileHits) continue;
    const measured = lines.filter(n => fileHits.has(n));
    if (measured.length === 0) continue;
    const uncovered = measured.filter(n => fileHits.get(n) === 0);
    rows.push({ file, measured: measured.length, covered: measured.length - uncovered.length, uncovered: toRanges(uncovered) });
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

function percent({ covered, total }: Counts): string {
  return total === 0 ? '–' : `${((100 * covered) / total).toFixed(1)}%`;
}

export function areaTable(rows: AreaCoverage[]): string {
  return [
    '| Area | Lines | Branches |',
    '|---|---:|---:|',
    ...rows.map(row => `| ${row.area} | ${percent(row.lines)} | ${percent(row.branches)} |`),
  ].join('\n');
}

export function changeTable(rows: FileChangeCoverage[]): string {
  if (rows.length === 0) return 'No changed line in the coverage report.';
  return [
    '| File | Changed lines covered | Not covered |',
    '|---|---:|---|',
    ...rows.map(row => `| ${row.file} | ${row.covered} of ${row.measured} | ${row.uncovered.join(', ')} |`),
  ].join('\n');
}
