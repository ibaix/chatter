import { STATE_PERIOD_KINDS, type StatePeriodKind } from '@local-chatter/shared';
import { z } from 'zod';

/**
 * The history backup of one machine: a .tar.gz file with these entries.
 *
 * manifest.json               what the file has (see Manifest), and the sha256 of each part
 * history/raw.jsonl.gz        the raw machine values from VictoriaMetrics (/api/v1/export, one series block on each line)
 * history/averages.jsonl.gz   the minute and hour averages that vmalert saved (vmalert does not make them again)
 * state-periods.jsonl.gz      the program, alarm, mode, run state and tool periods (one period on each line)
 * alert-rules.json            the alert rules of the machine, without their ids
 *
 * The file has no machine settings: no address, port, user, password or macro. Only the name and type are in the manifest.
 */

export const ARCHIVE_FORMAT = 'chatter-machine-history';
/** Change it when an older Chatter cannot read the new files. A Chatter refuses a newer format. */
export const FORMAT_VERSION = 1;
export const MANIFEST_NAME = 'manifest.json';
export const PART_NAMES = ['history/raw.jsonl.gz', 'history/averages.jsonl.gz', 'state-periods.jsonl.gz', 'alert-rules.json'] as const;
export type PartName = typeof PART_NAMES[number];
export const HISTORY_PARTS = ['history/raw.jsonl.gz', 'history/averages.jsonl.gz'] as const satisfies readonly PartName[];
export const PERIODS_PART: PartName = 'state-periods.jsonl.gz';
export const RULES_PART: PartName = 'alert-rules.json';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** The limits of a backup and of a restore. They keep a Pi with 512 MB of memory and a small SD card safe. */
export const ARCHIVE_LIMITS = {
  /** The whole file, and all its parts on the disk together */
  archiveBytes: 2 * GB,
  manifestBytes: 64 * KB,
  alertRulesBytes: 1 * MB,
  /** One JSONL line. VictoriaMetrics writes at most EXPORT_ROWS_PER_LINE samples on a line, about 300 KB. */
  lineBytes: 1 * MB,
  /** All the lines of one part after gunzip. A small file that unpacks to much more (a "zip bomb") stops here. */
  unpackedPartBytes: 16 * GB,
  /** Free space that must stay on the disk of the data volume, so the database can still write */
  freeSpaceReserveBytes: 256 * MB,
};

/** The most samples on one exported line */
export const EXPORT_ROWS_PER_LINE = 10_000;

/** A file that Chatter cannot restore. The message tells the user why. */
export class ArchiveError extends Error {}

const partSchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The samples of a history part, the periods, or the alert rules */
  count: z.number().int().nonnegative(),
});

const timeSchema = z.number().int().nonnegative();

const manifestSchema = z.strictObject({
  format: z.literal(ARCHIVE_FORMAT),
  formatVersion: z.number().int().positive(),
  chatterVersion: z.string().max(100),
  createdAt: z.string().max(40),
  machine: z.strictObject({ id: z.string().max(200), name: z.string().max(200), type: z.string().max(40) }),
  /** The time range that the user asked for. `from` is null for all the history. */
  range: z.strictObject({ from: timeSchema.nullable(), to: timeSchema }),
  averagesOnly: z.boolean(),
  /** The first and the last time of a sample or a period in the file. Null when the file has none. */
  data: z.strictObject({ first: timeSchema.nullable(), last: timeSchema.nullable() }),
  parts: z.partialRecord(z.enum(PART_NAMES), partSchema),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type PartFacts = z.infer<typeof partSchema>;

/** Read the manifest, and refuse a file of another kind or of a newer format */
export function parseManifest(text: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ArchiveError('The file is not a history backup of Chatter: its manifest.json is not JSON.');
  }
  const head = value as Partial<Manifest> | null;
  if (head?.format !== ARCHIVE_FORMAT) throw new ArchiveError('The file is not a history backup of Chatter.');
  if (typeof head.formatVersion === 'number' && head.formatVersion > FORMAT_VERSION) {
    throw new ArchiveError(`A newer Chatter made this file (format ${head.formatVersion}). Update Chatter, then try again.`);
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new ArchiveError(`The manifest.json of the file is not correct: ${firstIssue(parsed.error)}`);
  return parsed.data;
}

/** One state period in the file. The machine id is not in it: the restore gives the id of the target machine. */
export interface ArchivedPeriod {
  kind: StatePeriodKind;
  value: string;
  start: number;
  end: number;
}

const periodSchema = z.strictObject({
  kind: z.enum(STATE_PERIOD_KINDS),
  value: z.string().max(10_000),
  start: timeSchema,
  end: timeSchema,
}).refine(period => period.end >= period.start, { message: 'A period ends before it starts' });

export function parsePeriodLine(line: string): ArchivedPeriod {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ArchiveError('A line of the state periods is not JSON.');
  }
  const parsed = periodSchema.safeParse(value);
  if (!parsed.success) throw new ArchiveError(`A line of the state periods is not correct: ${firstIssue(parsed.error)}`);
  return parsed.data;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}
