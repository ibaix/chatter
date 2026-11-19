/**
 * READ-ONLY probe of a multi-path (for example a two-path lathe) FANUC control, to design multi-path support.
 *
 * It connects once, reads what the control is, and then for each path: selects the path (cnc_setpath, which
 * only changes which path this probe's own handle addresses; it writes nothing to the control) and dumps
 * the status, program, axes, spindles, modal codes, part count, alarms and a few parameters, each with its
 * FOCAS return code. A failing read is logged and the probe goes on. At the end it selects the path it found
 * first, frees the handle and ends the FOCAS process.
 *
 * It never writes: no parameter, macro, PMC, offset or program writes, no deletes, no uploads or downloads.
 *
 * Optionally it samples a short state line for each path every interval, so an operator can run one path
 * while the other is idle, and we see whether the paths differ.
 *
 * Output: a report on stdout, and a JSON dump (fanuc-probe-<ip>-<time>.json) in the current folder.
 *
 * Run it on Linux x64 (the dev container), for example:
 *   docker exec -it chatter-dev-server-1 sh -c "cd /app/apps/server && npx tsx scripts/fanuc-probe-paths.ts 192.168.0.105 --sample 180"
 *
 * Options:
 *   --port <n>        FOCAS port (8193)
 *   --timeout <s>     connect and call timeout in seconds (10)
 *   --sample <s>      sample the per-path state line for this many seconds (0: no sampling)
 *   --interval <ms>   time between samples (1000)
 *   --macros <list>   more macro variables to read on each path, for example 500,501 (read only)
 *   --out <folder>    folder for the JSON file (the current folder)
 */

import koffi from 'koffi';
import fs from 'fs';
import path from 'path';
import {
  Focas,
  ODBST,
  ODBSYS,
  toFocasStatus,
  toSystemInfo,
  type OdbstReply,
  type OdbsysReply,
} from '../src/machines/fanuc/focas.js';
import { FocasError } from '../src/machines/fanuc/focasError.js';

// ============================================
// Arguments
// ============================================

interface Options {
  host: string;
  port: number;
  timeoutSeconds: number;
  sampleSeconds: number;
  intervalMs: number;
  extraMacros: number[];
  outFolder: string;
}

function usage(): never {
  console.error('Usage: npx tsx scripts/fanuc-probe-paths.ts <ip> [--port 8193] [--timeout 10] [--sample 0] [--interval 1000] [--macros 500,501] [--out .]');
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    host: '', port: 8193, timeoutSeconds: 10, sampleSeconds: 0, intervalMs: 1000, extraMacros: [], outFolder: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) usage();
      return value;
    };
    const nextNumber = (): number => {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0) usage();
      return value;
    };
    if (arg === '--port') options.port = nextNumber();
    else if (arg === '--timeout') options.timeoutSeconds = nextNumber();
    else if (arg === '--sample') options.sampleSeconds = nextNumber();
    else if (arg === '--interval') options.intervalMs = Math.max(200, nextNumber());
    else if (arg === '--macros') options.extraMacros = next().split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
    else if (arg === '--out') options.outFolder = next();
    else if (arg === '--help' || arg === '-h') usage();
    else if (arg.startsWith('--')) usage();
    else if (!options.host) options.host = arg;
    else usage();
  }
  if (!options.host) usage();
  return options;
}

// ============================================
// FOCAS return codes
// ============================================

const EW_OK = 0;
const EW_LENGTH = 2;

const CODE_TEXT: Record<number, string> = {
  [-17]: 'EW_PROTOCOL', [-16]: 'EW_SOCKET', [-15]: 'EW_NODLL', [-11]: 'EW_BUS', [-10]: 'EW_SYSTEM2',
  [-9]: 'EW_HSSB', [-8]: 'EW_HANDLE', [-7]: 'EW_VERSION', [-6]: 'EW_UNEXP', [-5]: 'EW_SYSTEM',
  [-4]: 'EW_PARITY', [-3]: 'EW_MMCSYS', [-2]: 'EW_RESET', [-1]: 'EW_BUSY', 0: 'EW_OK',
  1: 'EW_FUNC (not supported)', 2: 'EW_LENGTH', 3: 'EW_NUMBER', 4: 'EW_ATTRIB', 5: 'EW_DATA',
  6: 'EW_NOOPT (no option)', 7: 'EW_PROT', 8: 'EW_OVRFLOW', 9: 'EW_PARAM', 10: 'EW_BUFFER',
  11: 'EW_PATH', 12: 'EW_MODE', 13: 'EW_REJECT', 14: 'EW_DTSRVR', 15: 'EW_ALARM', 16: 'EW_STOP',
  17: 'EW_PASSWD',
};

function codeText(code: number): string {
  return CODE_TEXT[code] ?? `code ${code}`;
}

/** The connection is gone: stop the probe, the next calls would only time out */
function isConnectionLost(code: number): boolean {
  return code === -16 || code === -8;
}

/** One FOCAS call: its return code, and its value when it worked */
interface CallResult<T = unknown> {
  fn: string;
  code: number;
  codeText: string;
  value?: T;
  error?: string;
}

let connectionLost = false;

/** Run one read. A failing read is kept with its code, and the probe goes on. */
function call<T>(fn: string, run: () => { code: number; value?: T }): CallResult<T> {
  if (connectionLost) return { fn, code: -16, codeText: 'skipped: connection lost' };
  try {
    const { code, value } = run();
    if (isConnectionLost(code)) connectionLost = true;
    return code === EW_OK ? { fn, code, codeText: codeText(code), value } : { fn, code, codeText: codeText(code) };
  } catch (error) {
    if (error instanceof FocasError) {
      if (isConnectionLost(error.code)) connectionLost = true;
      return { fn, code: error.code, codeText: codeText(error.code), error: error.message };
    }
    return { fn, code: NaN, codeText: 'exception', error: error instanceof Error ? error.message : String(error) };
  }
}

/** A read through Chatter's own Focas class, which throws FocasError on a failed call */
function connectorRead<T>(fn: string, read: () => T): CallResult<T> {
  return call(fn, () => ({ code: EW_OK, value: read() }));
}

// ============================================
// Raw buffers
// ============================================

/*
 * The functions that focas.ts does not bind are declared here with void* out buffers, which koffi passes
 * as the Buffer's own memory. Each buffer is larger than the biggest layout that the control may write
 * (MAX_AXIS is 32 and MAX_SPINDLE 8 on the 30i series), and the fields are decoded from fwlib32.h:
 * a FOCAS "long" is 32 bits (see the note in focas.ts), little-endian.
 */

function text(buffer: Buffer, offset: number, length: number): string {
  const bytes = buffer.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('latin1').trim();
}

function char(byte: number): string {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '';
}

function hex(buffer: Buffer, length: number): string {
  return buffer.subarray(0, length).toString('hex');
}

/** Koffi gives a char array as a string or as numbers */
function chars(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\0/g, '').trim();
  if (Array.isArray(value) || value instanceof Uint8Array) {
    return String.fromCharCode(...Array.from(value as ArrayLike<number>).filter(c => c !== 0)).trim();
  }
  return String(value ?? '');
}

const MAX_AXIS = 32;
const MAX_SPINDLE = 8;
const MAX_ALARMS = 10;
/** ODBALMMSG2: long alm_no, short type, short axis, short dummy, short msg_len, char alm_msg[64] */
const ALMMSG2_SIZE = 76;
/** ODBSPLOAD: two LOADELM of 12 bytes (long data, short dec, short unit, char name, suff1, suff2, reserve) */
const SPLOAD_SIZE = 24;
/** ODBSYSEX: 12 shorts, then one ODBSYSEX_path (8 shorts) for each path */
const SYSEX_HEADER = 24;
const SYSEX_PATH_SIZE = 16;

/** The cnc_* functions that only this probe uses. Every one of them only reads, except cnc_setpath (see above). */
function declareProbeFunctions(lib: koffi.IKoffiLib) {
  const f = (name: string, args: string[]) => lib.func(name, 'int16', args);
  return {
    statinfo: lib.func('cnc_statinfo', 'int16', ['uint16', koffi.out(koffi.pointer(ODBST))]),
    sysinfo: lib.func('cnc_sysinfo', 'int16', ['uint16', koffi.out(koffi.pointer(ODBSYS))]),
    getpath: f('cnc_getpath', ['uint16', 'void *', 'void *']),
    setpath: f('cnc_setpath', ['uint16', 'int16']),
    sysinfoEx: f('cnc_sysinfo_ex', ['uint16', 'void *']),
    rdaxisname: f('cnc_rdaxisname', ['uint16', 'void *', 'void *']),
    rdspdlname: f('cnc_rdspdlname', ['uint16', 'void *', 'void *']),
    acts2: f('cnc_acts2', ['uint16', 'int16', 'void *']),
    rdspmeter: f('cnc_rdspmeter', ['uint16', 'int16', 'void *', 'void *']),
    rdprgnum: f('cnc_rdprgnum', ['uint16', 'void *']),
    rdprgnumo8: f('cnc_rdprgnumo8', ['uint16', 'void *']),
    exeprgname: f('cnc_exeprgname', ['uint16', 'void *']),
    exeprgname2: f('cnc_exeprgname2', ['uint16', 'void *']),
    rdexecprog: f('cnc_rdexecprog', ['uint16', 'void *', 'void *', 'void *']),
    rdseqnum: f('cnc_rdseqnum', ['uint16', 'void *']),
    modal: f('cnc_modal', ['uint16', 'int16', 'int16', 'void *']),
    rdparam: f('cnc_rdparam', ['uint16', 'int16', 'int16', 'int16', 'void *']),
    rdmacro: f('cnc_rdmacro', ['uint16', 'int16', 'int16', 'void *']),
    alarm2: f('cnc_alarm2', ['uint16', 'void *']),
    rdalmmsg2: f('cnc_rdalmmsg2', ['uint16', 'int16', 'void *', 'void *']),
  };
}

type ProbeFunctions = ReturnType<typeof declareProbeFunctions>;

// ============================================
// Reads
// ============================================

class Reader {
  constructor(private readonly fns: ProbeFunctions, private readonly handle: number) {}

  getpath(): CallResult<{ path: number; maxPath: number }> {
    return call('cnc_getpath', () => {
      const p = Buffer.alloc(2);
      const max = Buffer.alloc(2);
      const code = this.fns.getpath(this.handle, p, max) as number;
      return { code, value: { path: p.readInt16LE(0), maxPath: max.readInt16LE(0) } };
    });
  }

  /** Only selects the path that this handle addresses. Writes nothing to the control. */
  setpath(pathNo: number): CallResult {
    return call(`cnc_setpath(${pathNo})`, () => ({ code: this.fns.setpath(this.handle, pathNo) as number }));
  }

  statinfoRaw() {
    return call('cnc_statinfo', () => {
      const reply = {} as OdbstReply & { hdck: number };
      const code = this.fns.statinfo(this.handle, reply) as number;
      const s = toFocasStatus(reply);
      return {
        code,
        value: {
          hdck: reply.hdck, tmmode: reply.tmmode, aut: reply.aut, run: reply.run, motion: reply.motion,
          mstb: reply.mstb, emergency: reply.emergency, alarm: reply.alarm, edit: reply.edit,
          autText: s.mode, runText: s.runState,
        },
      };
    });
  }

  sysinfo() {
    return call('cnc_sysinfo', () => {
      const reply = {} as OdbsysReply & { addinfo: number; axes: unknown };
      const code = this.fns.sysinfo(this.handle, reply) as number;
      return { code, value: { ...toSystemInfo(reply), addinfo: reply.addinfo, addinfoBits: reply.addinfo.toString(2), axes: chars(reply.axes) } };
    });
  }

  sysinfoEx() {
    return call('cnc_sysinfo_ex', () => {
      const b = Buffer.alloc(512);
      const code = this.fns.sysinfoEx(this.handle, b) as number;
      const header = {
        max_axis: b.readInt16LE(0), max_spdl: b.readInt16LE(2), max_path: b.readInt16LE(4), max_mchn: b.readInt16LE(6),
        ctrl_axis: b.readInt16LE(8), ctrl_srvo: b.readInt16LE(10), ctrl_spdl: b.readInt16LE(12),
        ctrl_path: b.readInt16LE(14), ctrl_mchn: b.readInt16LE(16),
      };
      const count = Math.max(0, Math.min(16, header.ctrl_path || header.max_path));
      const paths = Array.from({ length: count }, (_, i) => {
        const o = SYSEX_HEADER + i * SYSEX_PATH_SIZE;
        return {
          system: b.readInt16LE(o), group: b.readInt16LE(o + 2), attrib: b.readInt16LE(o + 4),
          ctrl_axis: b.readInt16LE(o + 6), ctrl_srvo: b.readInt16LE(o + 8), ctrl_spdl: b.readInt16LE(o + 10),
          mchn_no: b.readInt16LE(o + 12),
        };
      });
      return { code, value: { ...header, paths, raw: hex(b, SYSEX_HEADER + count * SYSEX_PATH_SIZE) } };
    });
  }

  axisNames() {
    return call('cnc_rdaxisname', () => {
      const num = Buffer.alloc(2);
      num.writeInt16LE(MAX_AXIS, 0);
      const b = Buffer.alloc(MAX_AXIS * 2 + 16);
      const code = this.fns.rdaxisname(this.handle, num, b) as number;
      const n = Math.min(MAX_AXIS, Math.max(0, num.readInt16LE(0)));
      return { code, value: Array.from({ length: n }, (_, i) => char(b[i * 2]) + char(b[i * 2 + 1])) };
    });
  }

  spindleNames() {
    return call('cnc_rdspdlname', () => {
      const num = Buffer.alloc(2);
      num.writeInt16LE(MAX_SPINDLE, 0);
      const b = Buffer.alloc(MAX_SPINDLE * 4 + 16);
      const code = this.fns.rdspdlname(this.handle, num, b) as number;
      const n = Math.min(MAX_SPINDLE, Math.max(0, num.readInt16LE(0)));
      return {
        code,
        value: Array.from({ length: n }, (_, i) => [0, 1, 2, 3].map(k => char(b[i * 4 + k])).join('')),
      };
    });
  }

  /** Actual speed of every spindle of the path (sp_no -1). The reply has no count, so all 8 slots are kept. */
  spindleSpeeds() {
    return call('cnc_acts2(-1)', () => {
      const b = Buffer.alloc(4 + MAX_SPINDLE * 4 + 16);
      const code = this.fns.acts2(this.handle, -1, b) as number;
      return {
        code,
        value: { datano: b.readInt16LE(0), type: b.readInt16LE(2), data: Array.from({ length: MAX_SPINDLE }, (_, i) => b.readInt32LE(4 + i * 4)) },
      };
    });
  }

  /** Load and speed meters of every spindle of the path (type -1) */
  spindleMeters() {
    return call('cnc_rdspmeter(-1)', () => {
      const num = Buffer.alloc(2);
      num.writeInt16LE(MAX_SPINDLE, 0);
      const b = Buffer.alloc(MAX_SPINDLE * SPLOAD_SIZE + 16);
      const code = this.fns.rdspmeter(this.handle, -1, num, b) as number;
      const n = Math.min(MAX_SPINDLE, Math.max(0, num.readInt16LE(0)));
      const meter = (o: number) => ({
        data: b.readInt32LE(o), dec: b.readInt16LE(o + 4), unit: b.readInt16LE(o + 6),
        name: char(b[o + 8]) + char(b[o + 9]) + char(b[o + 10]),
        value: b.readInt32LE(o) / Math.pow(10, b.readInt16LE(o + 4)),
      });
      return { code, value: Array.from({ length: n }, (_, i) => ({ load: meter(i * SPLOAD_SIZE), speed: meter(i * SPLOAD_SIZE + 12) })) };
    });
  }

  /** ODBPRO is short data/mdata by default, long with ONO8D (cnc_rdprgnumo8). Both are dumped. */
  programNumbers() {
    const short = call('cnc_rdprgnum', () => {
      const b = Buffer.alloc(16);
      const code = this.fns.rdprgnum(this.handle, b) as number;
      return { code, value: { data: b.readInt16LE(4), mdata: b.readInt16LE(6), raw: hex(b, 12) } };
    });
    const long = call('cnc_rdprgnumo8', () => {
      const b = Buffer.alloc(16);
      const code = this.fns.rdprgnumo8(this.handle, b) as number;
      return { code, value: { data: b.readInt32LE(4), mdata: b.readInt32LE(8), raw: hex(b, 12) } };
    });
    return { rdprgnum: short, rdprgnumo8: long };
  }

  executingProgram() {
    const name = call('cnc_exeprgname', () => {
      const b = Buffer.alloc(64);
      const code = this.fns.exeprgname(this.handle, b) as number;
      return { code, value: { name: text(b, 0, 36), o_num: b.readInt32LE(36) } };
    });
    const fullPath = call('cnc_exeprgname2', () => {
      const b = Buffer.alloc(260);
      const code = this.fns.exeprgname2(this.handle, b) as number;
      return { code, value: text(b, 0, 256) };
    });
    const block = call('cnc_rdexecprog', () => {
      const length = Buffer.alloc(2);
      length.writeUInt16LE(256, 0);
      const blknum = Buffer.alloc(2);
      const b = Buffer.alloc(260);
      const code = this.fns.rdexecprog(this.handle, length, blknum, b) as number;
      const n = Math.min(256, length.readUInt16LE(0));
      return { code, value: { blocks: blknum.readInt16LE(0), text: b.subarray(0, n).toString('latin1').replace(/\0/g, '').trim() } };
    });
    const sequence = call('cnc_rdseqnum', () => {
      const b = Buffer.alloc(16);
      const code = this.fns.rdseqnum(this.handle, b) as number;
      return { code, value: b.readInt32LE(4) };
    });
    return { exeprgname: name, exeprgname2: fullPath, rdexecprog: block, rdseqnum: sequence };
  }

  /**
   * The modal codes other than G (cnc_modal types 100..126, active block). The type numbers of each letter
   * differ by series, so every type is kept: compare with the screen (T code is usually 108).
   */
  modalCodes() {
    const results: Record<number, CallResult<{ aux_data: number; flag1: number; flag2: number }>> = {};
    for (let type = 100; type <= 126; type++) {
      results[type] = call(`cnc_modal(${type})`, () => {
        const b = Buffer.alloc(16);
        const code = this.fns.modal(this.handle, type, 0, b) as number;
        return { code, value: { aux_data: b.readInt32LE(4), flag1: b[8], flag2: b[9] } };
      });
    }
    return results;
  }

  /**
   * One parameter. Its size is not known ahead, so it tries long (8 bytes), then word (6) and byte (5)
   * while the control answers EW_LENGTH. axis 0 is a parameter that is not per axis.
   */
  param(number: number, axis = 0): CallResult<{ value: number; size: string; raw: string }> {
    const sizes: [number, string][] = [[8, 'long'], [6, 'word'], [5, 'byte']];
    let last: CallResult<{ value: number; size: string; raw: string }> | undefined;
    for (const [length, size] of sizes) {
      last = call(`cnc_rdparam(${number}, axis ${axis}, len ${length})`, () => {
        const b = Buffer.alloc(16);
        const code = this.fns.rdparam(this.handle, number, axis, length, b) as number;
        const value = size === 'long' ? b.readInt32LE(4) : size === 'word' ? b.readInt16LE(4) : b.readInt8(4);
        return { code, value: { value, size, raw: hex(b, length) } };
      });
      if (last.code !== EW_LENGTH) break;
    }
    return last!;
  }

  macro(number: number) {
    return call(`cnc_rdmacro(#${number})`, () => {
      const b = Buffer.alloc(16);
      const code = this.fns.rdmacro(this.handle, number, 10, b) as number;
      const value = b.readInt32LE(4);
      const dec = b.readInt16LE(8);
      // dec -1 means the variable is empty (vacant)
      return { code, value: { mcr_val: value, dec_val: dec, value: dec < 0 ? null : value / Math.pow(10, dec) } };
    });
  }

  alarmStatus() {
    return call('cnc_alarm2', () => {
      const b = Buffer.alloc(8);
      const code = this.fns.alarm2(this.handle, b) as number;
      const bits = b.readInt32LE(0);
      return { code, value: { bits, binary: (bits >>> 0).toString(2) } };
    });
  }

  alarmMessages2() {
    return call('cnc_rdalmmsg2(-1)', () => {
      const num = Buffer.alloc(2);
      num.writeInt16LE(MAX_ALARMS, 0);
      const b = Buffer.alloc(MAX_ALARMS * ALMMSG2_SIZE + 16);
      const code = this.fns.rdalmmsg2(this.handle, -1, num, b) as number;
      const n = Math.min(MAX_ALARMS, Math.max(0, num.readInt16LE(0)));
      return {
        code,
        value: Array.from({ length: n }, (_, i) => {
          const o = i * ALMMSG2_SIZE;
          const msgLen = b.readInt16LE(o + 10);
          return {
            alm_no: b.readInt32LE(o), type: b.readInt16LE(o + 4), axis: b.readInt16LE(o + 6),
            msg_len: msgLen, message: text(b, o + 12, Math.max(0, Math.min(64, msgLen))),
          };
        }),
      };
    });
  }
}

// ============================================
// Probe
// ============================================

/** Path-related parameters (30i / 0i-F numbering). The meaning is checked against the control's manual later. */
const PATH_PARAMS = [
  { number: 980, note: 'machine group of this path' },
  { number: 983, note: 'path control type (0 lathe, 1 machining center), where it exists' },
  { number: 6700, note: 'part count bits (which M code counts)' },
  { number: 6710, note: 'M code that counts a part' },
  { number: 6711, note: 'parts counted (shown as PART COUNT)' },
  { number: 6712, note: 'total parts' },
  { number: 6713, note: 'parts required' },
];
const AXIS_PATH_PARAM = 981;  // absolute path number of each axis
const SPINDLE_PATH_PARAM = 982;  // absolute path number of each spindle

/** System variables read with cnc_rdmacro (read only): parts, modal codes */
const SYSTEM_MACROS = [
  { number: 3901, note: 'parts completed' },
  { number: 3902, note: 'parts required' },
  { number: 4114, note: 'sequence number (modal N)' },
  { number: 4115, note: 'program number (modal O)' },
  { number: 4119, note: 'modal S' },
  { number: 4120, note: 'modal T' },
];

function probePath(reader: Reader, focas: Focas, pathNo: number, extraMacros: number[]) {
  const select = reader.setpath(pathNo);
  const confirm = reader.getpath();
  const axisNames = reader.axisNames();
  const spindleNames = reader.spindleNames();
  const axisCount = axisNames.value?.length ?? 0;
  const spindleCount = spindleNames.value?.length ?? 0;

  return {
    path: pathNo,
    setpath: select,
    getpathAfter: confirm,
    sysinfo: reader.sysinfo(),
    statinfo: reader.statinfoRaw(),
    axisNames,
    spindleNames,
    spindleSpeeds: reader.spindleSpeeds(),
    spindleMeters: reader.spindleMeters(),
    programNumbers: reader.programNumbers(),
    executing: reader.executingProgram(),
    modal: reader.modalCodes(),
    params: Object.fromEntries(PATH_PARAMS.map(p => [p.number, { note: p.note, ...reader.param(p.number) }])),
    axisPathParam: Array.from({ length: axisCount }, (_, i) => ({ axis: i + 1, name: axisNames.value?.[i], ...reader.param(AXIS_PATH_PARAM, i + 1) })),
    spindlePathParam: Array.from({ length: spindleCount }, (_, i) => ({ spindle: i + 1, name: spindleNames.value?.[i], ...reader.param(SPINDLE_PATH_PARAM, i + 1) })),
    macros: Object.fromEntries([...SYSTEM_MACROS, ...extraMacros.map(number => ({ number, note: 'from --macros' }))]
      .map(m => [m.number, { note: m.note, ...reader.macro(m.number) }])),
    alarmStatus: reader.alarmStatus(),
    alarmMessages2: reader.alarmMessages2(),
    // What Chatter's own reads (focas.ts) give on this path, through the same handle
    connector: {
      readStatus: connectorRead('Focas.readStatus', () => focas.readStatus()),
      readProgram: connectorRead('Focas.readProgram', () => focas.readProgram()),
      readSpindleSpeed: connectorRead('Focas.readSpindleSpeed', () => focas.readSpindleSpeed()),
      readSpindleLoad: connectorRead('Focas.readSpindleLoad', () => focas.readSpindleLoad()),
      readAlarms: connectorRead('Focas.readAlarms', () => focas.readAlarms()),
      readOperatorMessages: connectorRead('Focas.readOperatorMessages', () => focas.readOperatorMessages()),
    },
  };
}

type PathReport = ReturnType<typeof probePath>;

/** One compact state of one path, for the sampling loop */
function samplePath(reader: Reader, focas: Focas, pathNo: number) {
  const select = reader.setpath(pathNo);
  const st = reader.statinfoRaw();
  const prog = reader.executingProgram();
  const speeds = reader.spindleSpeeds();
  const load = connectorRead('Focas.readSpindleLoad', () => focas.readSpindleLoad());
  const alarm = reader.alarmStatus();
  const t = reader.macro(4120);
  return {
    path: pathNo,
    setpathCode: select.code,
    statinfoCode: st.code,
    aut: st.value?.aut, run: st.value?.run, motion: st.value?.motion, mstb: st.value?.mstb,
    emergency: st.value?.emergency, alarm: st.value?.alarm, edit: st.value?.edit,
    autText: st.value?.autText, runText: st.value?.runText,
    program: prog.exeprgname.value?.name, programCode: prog.exeprgname.code,
    sequence: prog.rdseqnum.value,
    spindleSpeeds: speeds.value?.data.slice(0, 4), spindleSpeedsCode: speeds.code,
    spindleLoad: load.value, spindleLoadCode: load.code,
    alarmBits: alarm.value?.bits,
    modalT: t.value?.value,
  };
}

function formatSample(s: ReturnType<typeof samplePath>): string {
  if (s.statinfoCode !== EW_OK) return `P${s.path} statinfo ${codeText(s.statinfoCode)}`;
  return `P${s.path} ${s.autText}/${s.runText} mot=${s.motion} mstb=${s.mstb} al=${s.alarm} em=${s.emergency}`
    + ` ${s.program ?? '-'} N${s.sequence ?? '-'} T${s.modalT ?? '-'} S=${(s.spindleSpeeds ?? []).join(',')}`
    + ` load=${s.spindleLoad ?? '-'}`;
}

// ============================================
// Report
// ============================================

function line(label: string, result: CallResult, show?: (value: never) => string): string {
  if (result.code !== EW_OK) return `  ${label.padEnd(22)} FAILED ${result.code} ${result.codeText}${result.error ? ` (${result.error})` : ''}`;
  const value = show ? show(result.value as never) : JSON.stringify(result.value);
  return `  ${label.padEnd(22)} ${value}`;
}

function printPath(p: PathReport): void {
  console.log(`\n=== Path ${p.path} ===`);
  console.log(line('setpath', p.setpath, () => 'ok'));
  console.log(line('getpath after', p.getpathAfter));
  console.log(line('sysinfo', p.sysinfo));
  console.log(line('statinfo', p.statinfo));
  console.log(line('axis names', p.axisNames));
  console.log(line('spindle names', p.spindleNames));
  console.log(line('spindle speeds (acts2)', p.spindleSpeeds));
  console.log(line('spindle meters', p.spindleMeters, (v: { load: { name: string; value: number; unit: number }; speed: { value: number } }[]) =>
    v.map(s => `${s.load.name}: load ${s.load.value}${s.load.unit === 0 ? '%' : ` (unit ${s.load.unit})`} speed ${s.speed.value}`).join('; ')));
  console.log(line('rdprgnum', p.programNumbers.rdprgnum));
  console.log(line('rdprgnumo8', p.programNumbers.rdprgnumo8));
  console.log(line('exeprgname', p.executing.exeprgname));
  console.log(line('exeprgname2', p.executing.exeprgname2));
  console.log(line('rdexecprog', p.executing.rdexecprog));
  console.log(line('rdseqnum', p.executing.rdseqnum));
  const modal = Object.entries(p.modal).filter(([, r]) => r.code === EW_OK).map(([type, r]) => `${type}=${r.value?.aux_data}`);
  const modalFailed = Object.values(p.modal).filter(r => r.code !== EW_OK);
  console.log(`  ${'modal (100..126)'.padEnd(22)} ${modal.join(' ') || '-'}${modalFailed.length ? `  (${modalFailed.length} types failed, first: ${modalFailed[0].code} ${modalFailed[0].codeText})` : ''}`);
  for (const [number, r] of Object.entries(p.params)) console.log(line(`param ${number}`, r, (v: { value: number; size: string }) => `${v.value} (${v.size}) - ${r.note}`));
  for (const r of p.axisPathParam) console.log(line(`param 981 axis ${r.axis} ${r.name ?? ''}`, r, (v: { value: number }) => String(v.value)));
  for (const r of p.spindlePathParam) console.log(line(`param 982 sp ${r.spindle} ${r.name ?? ''}`, r, (v: { value: number }) => String(v.value)));
  for (const [number, r] of Object.entries(p.macros)) console.log(line(`#${number}`, r, (v: { value: number | null }) => `${v.value ?? '<vacant>'} - ${r.note}`));
  console.log(line('alarm2 bits', p.alarmStatus));
  console.log(line('rdalmmsg2', p.alarmMessages2));
  console.log('  -- Chatter connector reads on this path --');
  for (const [name, r] of Object.entries(p.connector)) console.log(line(name, r as CallResult));
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const outFile = path.resolve(options.outFolder, `fanuc-probe-${options.host}-${stamp}.json`);
  const report: Record<string, unknown> = {
    probe: 'fanuc-probe-paths', version: 1, host: options.host, port: options.port, startedAt: started.toISOString(),
    platform: `${process.platform}/${process.arch}`, node: process.version,
  };
  const save = () => {
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  };

  console.log(`FANUC multi-path probe (read only) -> ${options.host}:${options.port}`);
  Focas.initialize();
  const libraryPath = Focas.libraryPath();
  report.library = libraryPath;
  // A second load of the same file gives the same library, so the probe's functions share Focas's FOCAS process
  const lib = koffi.load(libraryPath);
  const fns = declareProbeFunctions(lib);

  const focas = new Focas();
  const connectStart = Date.now();
  try {
    focas.connect(options.host, options.port, options.timeoutSeconds);
  } catch (error) {
    const code = error instanceof FocasError ? error.code : NaN;
    console.error(`Connect failed: ${code} ${codeText(code)} (${error instanceof Error ? error.message : error})`);
    report.connect = { code, codeText: codeText(code), ms: Date.now() - connectStart };
    save();
    console.log(`JSON: ${outFile}`);
    lib.unload();
    Focas.cleanup();
    process.exitCode = 1;
    return;
  }
  report.connect = { code: EW_OK, ms: Date.now() - connectStart };
  // The handle is private to Focas; the probe uses it for the reads that Focas does not have
  const handle = (focas as unknown as { handle: number }).handle;
  const reader = new Reader(fns, handle);

  let originalPath: number | undefined;
  let stop = false;
  let interrupts = 0;
  process.on('SIGINT', () => {
    stop = true;
    if (++interrupts > 1) process.exit(130);
    console.log('\nStopping after this sample (Ctrl-C again to quit at once)...');
  });

  try {
    // ---- The control ----
    const sysinfo = reader.sysinfo();
    const sysinfoEx = reader.sysinfoEx();
    const getpath = reader.getpath();
    const pathCount = connectorRead('Focas.readPathCount', () => focas.readPathCount());
    originalPath = getpath.value?.path;
    report.control = { sysinfo, sysinfoEx, getpath, connectorPathCount: pathCount };

    console.log('\n=== Control ===');
    console.log(line('sysinfo', sysinfo));
    console.log(line('sysinfo_ex', sysinfoEx, (v: { max_path: number; ctrl_path: number; ctrl_axis: number; ctrl_spdl: number; paths: unknown[] }) =>
      `max_path ${v.max_path}, ctrl_path ${v.ctrl_path}, ctrl_axis ${v.ctrl_axis}, ctrl_spdl ${v.ctrl_spdl}, paths ${JSON.stringify(v.paths)}`));
    console.log(line('getpath', getpath));

    const maxPath = getpath.value?.maxPath || sysinfoEx.value?.ctrl_path || 1;
    const paths = Array.from({ length: Math.max(1, Math.min(maxPath, 10)) }, (_, i) => i + 1);
    console.log(`  Paths to probe: ${paths.join(', ')}${maxPath > 10 ? ` (of ${maxPath})` : ''}`);

    // ---- Each path ----
    const pathReports: PathReport[] = [];
    for (const p of paths) {
      if (connectionLost) break;
      const r = probePath(reader, focas, p, options.extraMacros);
      pathReports.push(r);
      printPath(r);
    }
    report.paths = pathReports;
    save();

    // ---- Sampling ----
    if (options.sampleSeconds > 0 && !connectionLost) {
      console.log(`\n=== Sampling ${options.sampleSeconds}s every ${options.intervalMs}ms (Ctrl-C stops) ===`);
      const samples: { t: number; at: string; paths: ReturnType<typeof samplePath>[] }[] = [];
      report.samples = samples;
      const t0 = Date.now();
      while (!stop && !connectionLost && Date.now() - t0 < options.sampleSeconds * 1000) {
        const tickStart = Date.now();
        const sample = { t: Math.round((tickStart - t0) / 100) / 10, at: new Date().toISOString(), paths: paths.map(p => samplePath(reader, focas, p)) };
        samples.push(sample);
        console.log(`t=${String(sample.t).padStart(6)}s  ${sample.paths.map(formatSample).join('  |  ')}`);
        if (samples.length % 10 === 0) save();
        const wait = options.intervalMs - (Date.now() - tickStart);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  } finally {
    // ---- Restore and free ----
    if (originalPath && !connectionLost) {
      report.restorePath = reader.setpath(originalPath);
    }
    report.connectionLost = connectionLost;
    report.endedAt = new Date().toISOString();
    focas.disconnect();
    lib.unload();
    Focas.cleanup();
    save();
    console.log(`\nJSON: ${outFile}`);
    if (connectionLost) console.log('The connection was lost (EW_SOCKET or EW_HANDLE) during the probe; later reads were skipped.');
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
