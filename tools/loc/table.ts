// Prints the counts as Markdown. The output has no time in it, so the same refs always give the same text.
import type { FileCount, LineCount, Part } from './classify';

export interface Totals {
  parts: Record<Part, LineCount>;
  /** The reason of each file that is not counted, in the order of the files */
  notCounted: string[];
}

export interface Refs {
  base: string;
  /** The short sha of the merge base */
  baseSha: string;
  head: string;
  headSha: string;
}

const PARTS: [Part, string][] = [
  ['code', 'Application code'],
  ['tests', 'Tests'],
  ['docs', 'Docs and comments'],
  ['notCounted', 'Not counted'],
];

export function totalsOf(files: FileCount[]): Totals {
  const parts = Object.fromEntries(PARTS.map(([part]) => [part, { added: 0, removed: 0 }])) as Record<Part, LineCount>;
  const notCounted: string[] = [];
  for (const file of files) {
    for (const [part, count] of Object.entries(file.parts) as [Part, LineCount][]) {
      parts[part].added += count.added;
      parts[part].removed += count.removed;
    }
    if (file.reason) notCounted.push(file.reason);
  }
  return { parts, notCounted };
}

/** A short note for the "Not counted" row, for example "package-lock.json; 2 binary files" */
export function notCountedNote(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts]
    .map(([reason, count]) => {
      if (reason === 'binary') return `${count} binary ${count === 1 ? 'file' : 'files'}`;
      return count === 1 ? reason : `${count} ${reason} files`;
    })
    .join('; ');
}

const cell = (text: string) => text.replaceAll('|', '\\|');
const counts = ({ added, removed }: LineCount) => `+${added} | -${removed}`;

export function sizeTable(totals: Totals, refs: Refs): string {
  const note = notCountedNote(totals.notCounted);
  return [
    `Base: ${refs.base} (${refs.baseSha}), head: ${refs.head} (${refs.headSha})`,
    '',
    '| Part | Added | Removed |',
    '|---|---:|---:|',
    // A change with no file that is not counted gets no "Not counted" row
    ...PARTS.filter(([part]) => part !== 'notCounted' || totals.notCounted.length > 0).map(([part, label]) => {
      const name = part === 'notCounted' && note ? `${label} (${cell(note)})` : label;
      return `| ${name} | ${counts(totals.parts[part])} |`;
    }),
  ].join('\n');
}

/** One row for each part of each file */
export function filesTable(files: FileCount[]): string {
  const rows = files.flatMap(file => {
    const name = cell(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
    return PARTS.filter(([part]) => file.parts[part]).map(([part, label]) => {
      const partName = part === 'notCounted' && file.reason ? `${label} (${cell(file.reason)})` : label;
      return `| ${name} | ${partName} | ${counts(file.parts[part] as LineCount)} |`;
    });
  });
  return ['| File | Part | Added | Removed |', '|---|---|---:|---:|', ...rows].join('\n');
}
