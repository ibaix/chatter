/**
 * Check Chatter's FANUC (FOCAS2) connector against a real control. READ-ONLY: it calls only cnc_* reads
 * (statinfo, sysinfo, getpath, acts, rdspmeter, exeprgname, rdalmmsg, rdopmsg3, rdmacro) plus the handle
 * calls (allclibhndl3, freelibhndl) and the Linux process calls. It writes nothing to the control.
 *
 * It runs our own code: Focas (focas.ts) on FocasThreads/FocasThread (focasThread.ts, focasWorker.ts),
 * and FanucConnector.poll(), the call the poller makes. One section (--no-raw skips it) reads ODBST and ODBM
 * on the main thread with the connector's own struct definitions, to show the raw codes that the mapping hides.
 *
 * Run it on Linux x64 (the dev container), from apps/server:
 *   npx tsx scripts/fanuc-validate.ts <host> [port] [options]
 *
 * Options:
 *   --timeout <s>         FOCAS timeout, as the connector uses it (default 10)
 *   --poll-ms <ms>        poll interval (default 2000, as PollScheduler)
 *   --read-seconds <s>    per-read timing run on one session (default 30, 0 skips)
 *   --poll-seconds <s>    FanucConnector.poll() run (default 60, 0 skips)
 *   --tool-var <n>        macro variable of the tool number (as the machine setting)
 *   --part-var <n>        macro variable of the part count (as the machine setting)
 *   --macro <n>           another macro variable to read; repeat for more
 *   --cycles <n>          connect/read/disconnect cycles of the handle check (default 8, 0 skips)
 *   --no-raw              skip the main-thread raw ODBST/ODBM read
 *   --no-restart          skip the check that the FOCAS process starts again after every thread stopped
 *   --interactive         guided operator steps (mode switch, cycle start, feed hold, E-stop ...)
 *   --leak-test <n>       OPT-IN: remove and re-add the machine n times (FanucConnector.dispose()).
 *                         If dispose leaks handles, this can fill the control's FOCAS connections until
 *                         this script exits, which also blocks other FOCAS clients (the dev server) meanwhile.
 */

import koffi from 'koffi';
import readline from 'readline/promises';
import { isMachineRunning } from '@local-chatter/shared';
import { FanucConnector } from '../src/machines/fanuc/FanucConnector.js';
import { Focas, ODBM, ODBST } from '../src/machines/fanuc/focas.js';
import { FocasError, isConnectionLost } from '../src/machines/fanuc/focasError.js';
import { focasThreads, type FocasSession, type FocasThread } from '../src/machines/fanuc/focasThread.js';
import type { MachineDataSnapshot } from '../src/types/index.js';

// ============================================
// Arguments
// ============================================

interface Options {
  host: string;
  port: number;
  timeoutSeconds: number;
  pollMs: number;
  readSeconds: number;
  pollSeconds: number;
  toolVar?: number;
  partVar?: number;
  macros: number[];
  cycles: number;
  raw: boolean;
  restart: boolean;
  interactive: boolean;
  leakTest: number;
}

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage: npx tsx scripts/fanuc-validate.ts <host> [port] [--timeout s] [--poll-ms ms] [--read-seconds s] [--poll-seconds s]');
  console.error('       [--tool-var n] [--part-var n] [--macro n ...] [--cycles n] [--no-raw] [--no-restart] [--interactive] [--leak-test n]');
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const options: Omit<Options, 'host' | 'port'> = {
    timeoutSeconds: 10, pollMs: 2000, readSeconds: 30, pollSeconds: 60, macros: [],
    cycles: 8, raw: true, restart: true, interactive: false, leakTest: 0,
  };
  const number = (flag: string, value: string | undefined): number => {
    const parsed = Number(value);
    if (value === undefined || !Number.isFinite(parsed) || parsed < 0) usage(`${flag} needs a number`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--timeout': options.timeoutSeconds = number(arg, argv[++i]); break;
      case '--poll-ms': options.pollMs = number(arg, argv[++i]); break;
      case '--read-seconds': options.readSeconds = number(arg, argv[++i]); break;
      case '--poll-seconds': options.pollSeconds = number(arg, argv[++i]); break;
      case '--tool-var': options.toolVar = number(arg, argv[++i]); break;
      case '--part-var': options.partVar = number(arg, argv[++i]); break;
      case '--macro': options.macros.push(number(arg, argv[++i])); break;
      case '--cycles': options.cycles = number(arg, argv[++i]); break;
      case '--leak-test': options.leakTest = number(arg, argv[++i]); break;
      case '--no-raw': options.raw = false; break;
      case '--no-restart': options.restart = false; break;
      case '--interactive': options.interactive = true; break;
      case '-h': case '--help': usage();
      default:
        if (arg.startsWith('--')) usage(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length < 1 || positional.length > 2) usage('give the host, and optionally the port');
  const port = positional[1] === undefined ? 8193 : Number(positional[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage('the port must be 1-65535');
  return { host: positional[0], port, ...options };
}

// ============================================
// Report
// ============================================

type Level = 'PASS' | 'FAIL' | 'WARN' | 'INFO';
const results: Array<{ level: Level; section: string; message: string }> = [];
let section = '';

function heading(title: string): void {
  section = title;
  console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 70 - title.length))}`);
}

function report(level: Level, message: string): void {
  results.push({ level, section, message });
  console.log(`[${level}] ${message}`);
}

/** A line the operator compares with the control's screen */
function compare(what: string): void {
  console.log(`       compare: ${what}`);
}

function describeError(error: unknown): string {
  if (error instanceof FocasError) return `${error.message} (FOCAS code ${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof FocasError ? String(error.code) : 'no-code';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Rejects when the promise takes longer than ms, so a call that hangs is reported, not waited on for ever */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number }> {
  const start = performance.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: performance.now() - start };
  } catch (error) {
    return { ok: false, error, ms: performance.now() - start };
  }
}

const fmtMs = (ms: number) => `${ms.toFixed(1)} ms`;

// ============================================
// What the raw values mean (FOCAS2 documentation, 0i/16i/30i ODBST)
// ============================================

const EMERGENCY_TEXT: Record<number, string> = { 0: 'not emergency', 1: 'EMERGENCY', 2: 'RESET (reset signal on)', 3: 'WAIT' };
const ALARM_TEXT: Record<number, string> = {
  0: 'none', 1: 'ALARM', 2: 'BATTERY LOW', 3: 'FAN', 4: 'PS warning', 5: 'FSSB warning',
  6: 'insulation warning', 7: 'encoder warning', 8: 'PMC alarm',
};
const MOTION_TEXT: Record<number, string> = { 0: 'none', 1: 'MOTION', 2: 'DWELL' };
/** cnc_rdalmmsg type -> the prefix the alarm screen shows on 0i-D/F and 30i (other series may differ) */
const ALARM_PREFIX: Record<number, string> = {
  0: 'SW', 1: 'PW', 2: 'IO', 3: 'PS', 4: 'OT', 5: 'OH', 6: 'SV', 7: 'SR', 8: 'MC', 9: 'SP',
  10: 'DS', 11: 'IE', 12: 'BG', 13: 'SN', 15: 'EX', 19: 'PC',
};

/** System variables worth knowing on most controls. Read only. */
const SYSTEM_VARIABLES: Array<{ number: number; meaning: string }> = [
  { number: 3901, meaning: 'parts count (PART COUNT on the position screen)' },
  { number: 3902, meaning: 'parts required' },
  { number: 4120, meaning: 'modal T code (T on the program check screen)' },
];

// ============================================
// Sections
// ============================================

function checkEnvironment(): boolean {
  heading('1. Environment');
  report('INFO', `platform ${process.platform}/${process.arch}, node ${process.version}`);
  report('INFO', `LD_LIBRARY_PATH=${process.env.LD_LIBRARY_PATH ?? '(not set)'}`);
  try {
    report('INFO', `library file: ${Focas.libraryPath()}`);
  } catch (error) {
    report('FAIL', `no FOCAS library for this platform: ${describeError(error)}`);
    return false;
  }
  if (!Focas.isAvailable()) {
    report('FAIL', Focas.getPlatformMessage());
    return false;
  }
  report('PASS', Focas.getPlatformMessage());
  return true;
}

async function loadLibrary(): Promise<boolean> {
  heading('2. Load the library on a FOCAS thread (cnc_startupprocess on Linux)');
  const result = await timed(() => within(focasThreads.initialize(), 30_000, 'initialize'));
  if (!result.ok) {
    report('FAIL', `library did not load: ${describeError(result.error)}`);
    return false;
  }
  report('PASS', `library loaded and FOCAS process started in ${fmtMs(result.ms)}`);
  return true;
}

async function connectSession(thread: FocasThread, options: Options): Promise<FocasSession | null> {
  heading(`3. Connect (cnc_allclibhndl3 ${options.host}:${options.port}, timeout ${options.timeoutSeconds} s)`);
  const result = await timed(() => within(
    thread.connect(options.host, options.port, options.timeoutSeconds),
    options.timeoutSeconds * 1000 + 15_000, 'connect',
  ));
  if (!result.ok) {
    report('FAIL', `connect failed after ${fmtMs(result.ms)}: ${describeError(result.error)}`);
    console.log('       -16 (socket): wrong IP/port, FOCAS2/Ethernet not enabled, firewall, cable, or no free FOCAS connection on the control.');
    console.log('       Check on the control: SYSTEM > embedded Ethernet settings (FOCAS2 port, usually 8193), and ping the IP.');
    return null;
  }
  report('PASS', `connected in ${fmtMs(result.ms)}`);
  return result.value;
}

async function readControlIdentity(session: FocasSession): Promise<void> {
  heading('4. What the control is (cnc_sysinfo, cnc_getpath)');
  const sys = await timed(() => session.readSystemInfo());
  if (sys.ok) {
    const info = sys.value;
    report('INFO', `series "${info.cncType}", type "${info.mtType}", software ${info.series} version ${info.version}, max axes ${info.maxAxes} (${fmtMs(sys.ms)})`);
    compare('SYSTEM > system configuration screen (series and software version)');
    if (info.cncType === '15') report('FAIL', 'Series 15: Chatter refuses it, the ODBST layout differs');
    else report('PASS', 'not a Series 15, so the ODBST layout Chatter uses applies');
  } else {
    report('WARN', `cnc_sysinfo failed: ${describeError(sys.error)}`);
  }
  const paths = await timed(() => session.readPathCount());
  if (paths.ok) {
    report(paths.value > 1 ? 'WARN' : 'INFO', `paths: ${paths.value}${paths.value > 1 ? ' (Chatter reads only path 1)' : ''}`);
  } else {
    report('WARN', `cnc_getpath failed: ${describeError(paths.error)}`);
  }
}

function macroList(options: Options): Array<{ number: number; meaning: string }> {
  const list: Array<{ number: number; meaning: string }> = [];
  if (options.toolVar) list.push({ number: options.toolVar, meaning: 'tool number variable (setting)' });
  if (options.partVar) list.push({ number: options.partVar, meaning: 'part count variable (setting)' });
  for (const number of options.macros) list.push({ number, meaning: 'macro (--macro)' });
  for (const sys of SYSTEM_VARIABLES) {
    if (!list.some(entry => entry.number === sys.number)) list.push(sys);
  }
  return list;
}

async function readEachField(session: FocasSession, options: Options): Promise<void> {
  heading('5. Each value the connector reads (through FocasThread)');

  const status = await timed(() => session.readStatus());
  if (status.ok) {
    const s = status.value;
    report('PASS', `cnc_statinfo (${fmtMs(status.ms)})`);
    console.log(`       mode      aut=${s.modeCode} -> ${s.mode}`);
    compare('mode on the status line at the bottom of the screen (MEM, MDI, EDIT, JOG, HND, INC, REF, RMT)');
    console.log(`       run       run=${s.runStateCode} -> ${s.runState} -> running=${isMachineRunning({ runState: s.runState })}`);
    compare('run status on the status line (**** = RESET, STOP, HOLD, STRT, MSTR)');
    console.log(`       motion=${s.motion} (${MOTION_TEXT[s.motion] ?? '?'}), mstb=${s.mstb}, edit=${s.edit}, tmmode=${s.tmMode}`);
    console.log(`       emergency -> ${s.emergency}, alarm flag -> ${s.alarm}  (raw codes in section 6)`);
    compare('EMG / ALM / BAT / FAN blinking on the status line');
  } else {
    report('FAIL', `cnc_statinfo failed: ${describeError(status.error)}. Every poll would fail.`);
  }

  const speed = await timed(() => session.readSpindleSpeed());
  if (speed.ok) {
    report('PASS', `cnc_acts spindle speed = ${speed.value.speed} rpm (${fmtMs(speed.ms)})`);
    compare('actual spindle speed (ACT. S / "S" on the position or operating monitor screen); 0 without a position coder');
  } else report('WARN', `cnc_acts failed: ${describeError(speed.error)} (Chatter leaves spindle speed out)`);

  const load = await timed(() => session.readSpindleLoad());
  if (load.ok) {
    report(load.value === undefined ? 'INFO' : 'PASS', `cnc_rdspmeter spindle load = ${load.value === undefined ? 'none (no serial spindle read, or not percent)' : `${load.value} %`} (${fmtMs(load.ms)})`);
    compare('spindle load meter (operating monitor screen, or the load bar on the position screen)');
  } else report('WARN', `cnc_rdspmeter failed: ${describeError(load.error)} (Chatter leaves spindle load out)`);

  const program = await timed(() => session.readProgram());
  if (program.ok) {
    const p = program.value;
    report('PASS', `cnc_exeprgname name="${p.name}" o_num=${p.number} -> Chatter shows "${p.name || `O${p.number}`}" (${fmtMs(program.ms)})`);
    compare('program name / O number at the top right of the PROG screen');
  } else report('WARN', `cnc_exeprgname failed: ${describeError(program.error)} (Chatter leaves program out)`);

  const alarms = await timed(() => session.readAlarms());
  if (alarms.ok) {
    report('PASS', `cnc_rdalmmsg: ${alarms.value.length} alarm(s) (${fmtMs(alarms.ms)})`);
    for (const a of alarms.value) {
      const prefix = ALARM_PREFIX[a.type] ?? `type${a.type}`;
      console.log(`       no=${a.alarmNo} type=${a.type} (screen probably ${prefix}${String(a.alarmNo).padStart(4, '0')}) axis=${a.axis} "${a.message}" -> Chatter alarmCode "${a.alarmNo}"`);
    }
    compare('MESSAGE > ALARM screen. Note: Chatter stores only the number, without the PS/SV/OT prefix.');
  } else report('WARN', `cnc_rdalmmsg failed: ${describeError(alarms.error)} (Chatter falls back to the status alarm flag)`);

  const messages = await timed(() => session.readOperatorMessages());
  if (messages.ok) {
    report('PASS', `cnc_rdopmsg3: ${messages.value.length} message(s) (${fmtMs(messages.ms)})`);
    for (const m of messages.value) console.log(`       no=${m.number} type=${m.type} "${m.message}"`);
    compare('MESSAGE > OPERATOR MESSAGE screen. Chatter shows the last one whose type is not ignored.');
  } else report('WARN', `cnc_rdopmsg3 failed: ${describeError(messages.error)} (Chatter shows no message)`);

  for (const macro of macroList(options)) {
    const result = await timed(() => session.readMacro(macro.number));
    if (result.ok) {
      const m = result.value;
      report('INFO', `cnc_rdmacro #${macro.number} = ${m.value} (dec=${m.decimalPlaces}; floor ${Math.floor(m.value)}) - ${macro.meaning} (${fmtMs(result.ms)})`);
      if (m.decimalPlaces === -1) report('WARN', `#${macro.number} looks vacant (dec_val -1): Chatter shows ${m.value}, not "no value"`);
    } else {
      report('INFO', `cnc_rdmacro #${macro.number} failed: ${describeError(result.error)} - ${macro.meaning}`);
    }
  }
  compare('OFFSET/SETTING > MACRO screen for each variable; PART COUNT on the position screen for #3901');
}

/**
 * The raw ODBST and ODBM codes, read on the main thread with the connector's own struct definitions.
 * The library is already loaded and its process started by the FOCAS thread, so this does not start it again.
 * It uses one more FOCAS handle for a moment, and frees it.
 */
function readRawCodes(options: Options): void {
  heading('6. Raw codes (main thread, connector struct definitions ODBST / ODBM)');
  let lib: koffi.IKoffiLib;
  try {
    lib = koffi.load(Focas.libraryPath());
  } catch (error) {
    report('WARN', `could not load the library on the main thread: ${describeError(error)}`);
    return;
  }
  const allclibhndl3 = lib.func('cnc_allclibhndl3', 'int16', ['str', 'uint16', 'int32', koffi.out(koffi.pointer('uint16'))]);
  const freelibhndl = lib.func('cnc_freelibhndl', 'int16', ['uint16']);
  const statinfo = lib.func('cnc_statinfo', 'int16', ['uint16', koffi.out(koffi.pointer(ODBST))]);
  const rdmacro = lib.func('cnc_rdmacro', 'int16', ['uint16', 'int16', 'int16', koffi.out(koffi.pointer(ODBM))]);

  const handle = [0];
  const connected = allclibhndl3(options.host, options.port, options.timeoutSeconds, handle) as number;
  if (connected !== 0) {
    report('WARN', `raw connect failed with code ${connected}; skipping the raw codes`);
    return;
  }
  try {
    const st: Record<string, number> = {};
    const code = statinfo(handle[0], st) as number;
    if (code !== 0) {
      report('WARN', `raw cnc_statinfo code ${code}`);
    } else {
      console.log(`       ODBST ${JSON.stringify(st)}`);
      report('INFO', `emergency=${st.emergency} (${EMERGENCY_TEXT[st.emergency] ?? '?'}) -> Chatter emergency=${st.emergency !== 0}`);
      if (st.emergency >= 2) report('WARN', `emergency=${st.emergency} is not an E-stop, but Chatter treats any non-zero value as one`);
      report('INFO', `alarm=${st.alarm} (${ALARM_TEXT[st.alarm] ?? '?'}) -> Chatter alarm flag=${st.alarm !== 0}`);
      if (st.alarm >= 2) report('WARN', `alarm=${st.alarm} is a warning (${ALARM_TEXT[st.alarm] ?? '?'}), but Chatter treats any non-zero value as an alarm`);
    }
    const macros = macroList(options).map(entry => entry.number).filter(number => number <= 32767);
    for (const number of macros) {
      const reply: Record<string, number> = {};
      const result = rdmacro(handle[0], number, 10, reply) as number;
      console.log(`       ODBM #${number}: code ${result} ${result === 0 ? JSON.stringify(reply) : ''}`);
    }
  } finally {
    const freed = freelibhndl(handle[0]) as number;
    report(freed === 0 ? 'PASS' : 'WARN', `raw handle freed (cnc_freelibhndl code ${freed})`);
  }
}

interface ReadStats { times: number[]; errors: Map<string, number> }

async function timeReads(thread: FocasThread, session: FocasSession, options: Options): Promise<FocasSession> {
  heading(`7. Per-read timing on one session (${options.readSeconds} s, every ${options.pollMs} ms)`);
  const reads: Array<[string, (s: FocasSession) => Promise<unknown>]> = [
    ['readStatus', s => s.readStatus()],
    ['readSpindleSpeed', s => s.readSpindleSpeed()],
    ['readSpindleLoad', s => s.readSpindleLoad()],
    ['readProgram', s => s.readProgram()],
    ['readAlarms', s => s.readAlarms()],
    ['readOperatorMessages', s => s.readOperatorMessages()],
    ...macroList(options).slice(0, 3).map(m => [`readMacro#${m.number}`, (s: FocasSession) => s.readMacro(m.number)] as [string, (s: FocasSession) => Promise<unknown>]),
  ];
  const stats = new Map<string, ReadStats>(reads.map(([name]) => [name, { times: [], errors: new Map() }]));
  const cycleTimes: number[] = [];
  let reconnects = 0;
  let current = session;
  const end = Date.now() + options.readSeconds * 1000;

  while (Date.now() < end) {
    const cycleStart = performance.now();
    for (const [name, read] of reads) {
      const result = await timed(() => within(read(current), options.timeoutSeconds * 1000 + 5000, name));
      const entry = stats.get(name)!;
      entry.times.push(result.ms);
      if (!result.ok) {
        const key = errorCode(result.error);
        entry.errors.set(key, (entry.errors.get(key) ?? 0) + 1);
        if (isConnectionLost(result.error)) {
          console.log(`       ${name}: connection lost (${describeError(result.error)}), reconnecting`);
          current.disconnect().catch(() => undefined);
          current = await thread.connect(options.host, options.port, options.timeoutSeconds);
          reconnects++;
          break;
        }
      }
    }
    const cycleMs = performance.now() - cycleStart;
    cycleTimes.push(cycleMs);
    await sleep(Math.max(0, options.pollMs - cycleMs));
  }

  const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  };
  console.log('       read                       n    min    p50    p95    max   errors (FOCAS code: count)');
  for (const [name, entry] of stats) {
    const errors = [...entry.errors].map(([code, count]) => `${code}:${count}`).join(' ') || '-';
    console.log(`       ${name.padEnd(24)} ${String(entry.times.length).padStart(4)} ${[0, 0.5, 0.95, 1].map(p => percentile(entry.times, p).toFixed(1).padStart(6)).join(' ')}   ${errors}`);
  }
  const p95 = percentile(cycleTimes, 0.95);
  report('INFO', `${cycleTimes.length} cycles; one cycle of all reads: p50 ${fmtMs(percentile(cycleTimes, 0.5))}, p95 ${fmtMs(p95)}, max ${fmtMs(percentile(cycleTimes, 1))}`);
  report(p95 < 8000 ? 'PASS' : 'FAIL', `p95 cycle ${p95 < 8000 ? 'is within' : 'exceeds'} the connector's 8 s read deadline (poll limit 10 s)`);
  const failed = [...stats.values()].some(entry => entry.errors.size > 0);
  report(failed ? 'WARN' : 'PASS', failed ? 'some reads failed (codes above)' : 'no read failed');
  report(reconnects === 0 ? 'PASS' : 'WARN', `reconnects: ${reconnects}`);
  return current;
}

/** The values the dashboard and history get, in one line */
function summary(snapshot: MachineDataSnapshot): string {
  const c = snapshot.custom ?? {};
  return [
    `connected=${snapshot.connected}`, `mode=${snapshot.mode}`, `run=${snapshot.runState}`,
    `running=${isMachineRunning({ runState: snapshot.runState })}`, `program=${snapshot.program}`,
    `tool=${snapshot.toolNumber}`, `parts=${snapshot.partCount}`, `S=${snapshot.spindleSpeed}`,
    `load=${snapshot.spindleLoad}`, `alarm=${snapshot.alarm}`, `code=${snapshot.alarmCode}`,
    `msg=${snapshot.alarmMessage}`, `estop=${snapshot.emergency}`, `opmsg=${c.operatorMessage}`,
  ].join(' ');
}

function newConnector(options: Options, id: string): FanucConnector {
  return new FanucConnector({
    id, name: 'fanuc-validate', host: options.host, focasPort: options.port, timeout: options.timeoutSeconds,
    toolNumberVariable: options.toolVar, partCounterVariable: options.partVar,
    macros: options.macros.map(location => ({ location })),
  });
}

async function pollOnce(connector: FanucConnector): Promise<{ ms: number; errors: string[]; connected: boolean }> {
  const result = await timed(() => connector.poll());
  const status = result.ok ? result.value : connector.getStatus();
  return { ms: result.ms, errors: status.errors, connected: status.connected };
}

async function runConnector(connector: FanucConnector, options: Options): Promise<void> {
  heading(`8. FanucConnector.poll() (${options.pollSeconds} s, every ${options.pollMs} ms)`);
  connector.on('data', (changes: Array<{ label: string; value: unknown }>) => {
    console.log(`       data event: ${changes.map(change => `${change.label}=${JSON.stringify(change.value)}`).join(', ')}`);
  });
  const times: number[] = [];
  let failures = 0;
  let reconnects = 0;
  let wasConnected = false;
  let last = '';
  const end = Date.now() + options.pollSeconds * 1000;
  while (Date.now() < end) {
    const poll = await pollOnce(connector);
    times.push(poll.ms);
    if (poll.connected && !wasConnected && times.length > 1) reconnects++;
    wasConnected = poll.connected;
    if (poll.errors.length > 0) {
      failures++;
      console.log(`       poll errors: ${poll.errors.join('; ')}`);
    }
    if (poll.ms > 10_000) report('FAIL', `a poll took ${fmtMs(poll.ms)}, over the PollScheduler limit of 10 s`);
    const line = summary(connector.getDataSnapshot());
    if (line !== last) {
      console.log(`       ${new Date().toISOString().slice(11, 19)} ${line}`);
      last = line;
    }
    await sleep(Math.max(0, options.pollMs - poll.ms));
  }
  const sorted = [...times].sort((a, b) => a - b);
  report('INFO', `${times.length} polls: first ${fmtMs(times[0] ?? 0)} (includes connect + sysinfo), p50 ${fmtMs(sorted[Math.floor(sorted.length / 2)] ?? 0)}, max ${fmtMs(sorted.at(-1) ?? 0)}`);
  report(failures === 0 ? 'PASS' : 'WARN', `polls with errors: ${failures}`);
  report(reconnects === 0 ? 'PASS' : 'WARN', `reconnects during the run: ${reconnects}`);
  report(connector.checkConnection() ? 'PASS' : 'FAIL', `connected at the end: ${connector.checkConnection()}`);
}

interface GuidedStep { prompt: string; expect: string }

const GUIDED_STEPS: GuidedStep[] = [
  { prompt: 'Turn the mode switch to EDIT.', expect: 'mode=EDIT' },
  { prompt: 'Turn the mode switch to MDI.', expect: 'mode=MDI' },
  { prompt: 'Turn the mode switch to JOG (or HANDLE).', expect: 'mode=JOG / HANDLE' },
  { prompt: 'MEM mode, select a program, press CYCLE START (ONLY if it is safe: dry run / machine lock / single block as you see fit).', expect: 'mode=MEMORY run=START running=true, program matches the PROG screen' },
  { prompt: 'Press FEED HOLD while it runs.', expect: 'run=HOLD running=false' },
  { prompt: 'Press RESET.', expect: 'run=RESET running=false' },
  { prompt: 'Run the spindle at a known speed (for example MDI S500 M3) ONLY if it is safe.', expect: 'S close to the commanded speed, load matches the load meter' },
  { prompt: 'Press EMERGENCY STOP.', expect: 'estop=true alarm=true, code E-STOP or the real alarm number (for example 1000-series EX/SV alarm)' },
  { prompt: 'Release EMERGENCY STOP and press RESET.', expect: 'estop=false; alarm=false once the alarm screen is clear' },
];

async function guidedSteps(connector: FanucConnector): Promise<void> {
  heading('9. Guided operator steps (OPTIONAL, needs the operator at the control)');
  console.log('       Each step: do it on the control, then press Enter to read. Type s + Enter to skip a step, q to stop.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [index, step] of GUIDED_STEPS.entries()) {
      const go = (await rl.question(`\n  Step ${index + 1}: ${step.prompt}\n  [Enter]=read, s=skip, q=quit > `)).trim().toLowerCase();
      if (go === 'q') break;
      if (go === 's') { report('INFO', `step ${index + 1} skipped`); continue; }
      await pollOnce(connector);
      console.log(`       Chatter: ${summary(connector.getDataSnapshot())}`);
      console.log(`       expect:  ${step.expect}`);
      const answer = (await rl.question('  Does Chatter match the control screen? [y/n] > ')).trim().toLowerCase();
      const note = answer === 'n' ? (await rl.question('  What did the screen show? > ')).trim() : '';
      report(answer === 'y' ? 'PASS' : answer === 'n' ? 'FAIL' : 'INFO', `step ${index + 1} (${step.prompt.split('.')[0]})${note ? `: screen showed "${note}"` : ''}`);
    }
  } finally {
    rl.close();
  }
}

async function reconnectChecks(connector: FanucConnector, thread: FocasThread, options: Options): Promise<void> {
  heading('10. Disconnect, reconnect and handle cleanup');

  connector.disconnect();
  const again = await pollOnce(connector);
  report(again.connected ? 'PASS' : 'FAIL', `disconnect() then poll() reconnects (${fmtMs(again.ms)})${again.errors.length ? `: ${again.errors.join('; ')}` : ''}`);

  if (options.cycles > 0) {
    let ok = 0;
    for (let i = 0; i < options.cycles; i++) {
      const result = await timed(async () => {
        const session = await thread.connect(options.host, options.port, options.timeoutSeconds);
        await session.readStatus();
        await session.disconnect();
      });
      if (result.ok) ok++;
      else { report('FAIL', `cycle ${i + 1}: ${describeError(result.error)}`); break; }
    }
    report(ok === options.cycles ? 'PASS' : 'FAIL',
      `${ok}/${options.cycles} connect/read/disconnect cycles. All passing means cnc_freelibhndl frees the handle (a leak would hit the control's connection limit).`);
  }

  // A machine removed (dispose) and added again: a new FOCAS thread loads the library without starting the process
  connector.dispose();
  const readded = newConnector(options, 'fanuc-validate-2');
  const poll = await pollOnce(readded);
  report(poll.connected ? 'PASS' : 'FAIL', `after dispose(), a new connector on a new FOCAS thread connects (${fmtMs(poll.ms)})${poll.errors.length ? `: ${poll.errors.join('; ')}` : ''}`);
  readded.disconnect();
  await sleep(300);
}

/** OPT-IN: whether dispose() leaks the handle (it sends the disconnect and terminates the worker at once) */
async function leakTest(options: Options): Promise<void> {
  heading(`11. OPT-IN dispose() leak test (${options.leakTest} remove/add cycles)`);
  for (let i = 0; i < options.leakTest; i++) {
    const connector = newConnector(options, `fanuc-leak-${i}`);
    const poll = await pollOnce(connector);
    connector.dispose();
    if (!poll.connected) {
      report('FAIL', `cycle ${i + 1}: could not connect after ${i} dispose() calls: ${poll.errors.join('; ')}. dispose() probably leaks the FOCAS handle.`);
      return;
    }
  }
  report('PASS', `${options.leakTest} dispose() cycles all connected; no handle leak seen at this count`);
}

/** The PR's untested claim: when no thread has the library, the next one calls cnc_startupprocess again */
async function restartCheck(options: Options): Promise<void> {
  heading('12. FOCAS process start again after every thread stopped (no cnc_exitprocess between)');
  await focasThreads.stop();
  const connector = newConnector(options, 'fanuc-validate-3');
  const poll = await pollOnce(connector);
  report(poll.connected ? 'PASS' : 'FAIL', `after every FOCAS thread stopped, a new thread loads, starts the process again and connects${poll.errors.length ? `: ${poll.errors.join('; ')}` : ''}`);
  connector.disconnect();
  await sleep(300);
}

async function shutDownCheck(): Promise<void> {
  heading('13. Shutdown (free handles, cnc_exitprocess, stop threads)');
  const result = await timed(() => focasThreads.shutDown());
  report(result.ok && result.ms < 3500 ? 'PASS' : 'WARN', `focasThreads.shutDown() took ${fmtMs(result.ms)}${result.ok ? '' : `: ${describeError(result.error)}`}`);
}

function printSummary(): number {
  heading('Summary');
  const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 };
  for (const result of results) counts[result.level]++;
  console.log(`PASS ${counts.PASS}  FAIL ${counts.FAIL}  WARN ${counts.WARN}  INFO ${counts.INFO}`);
  for (const result of results.filter(r => r.level === 'FAIL' || r.level === 'WARN')) {
    console.log(`[${result.level}] ${result.section}: ${result.message}`);
  }
  return counts.FAIL > 0 ? 1 : 0;
}

// ============================================
// Main
// ============================================

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`FANUC FOCAS read-only validation of ${options.host}:${options.port}, ${new Date().toISOString()}`);

  process.once('SIGINT', () => {
    console.log('\nInterrupted: freeing the FOCAS handles');
    focasThreads.shutDown().finally(() => process.exit(130));
  });

  if (!checkEnvironment()) return printSummary();
  if (!(await loadLibrary())) return printSummary();

  const thread = focasThreads.thread();
  let session = await connectSession(thread, options);
  if (!session) {
    await shutDownCheck();
    return printSummary();
  }

  await readControlIdentity(session);
  await readEachField(session, options);
  if (options.raw) readRawCodes(options);
  if (options.readSeconds > 0) session = await timeReads(thread, session, options);

  const connector = newConnector(options, 'fanuc-validate');
  if (options.pollSeconds > 0) await runConnector(connector, options);
  if (options.interactive) await guidedSteps(connector);
  await reconnectChecks(connector, thread, options);
  if (options.leakTest > 0) await leakTest(options);

  await session.disconnect().catch(error => report('WARN', `session disconnect: ${describeError(error)}`));
  if (options.restart) await restartCheck(options);
  await shutDownCheck();
  return printSummary();
}

main().then(
  code => process.exit(code),
  error => {
    console.error('Validation stopped by an unexpected error:', error);
    focasThreads.shutDown().finally(() => process.exit(1));
  },
);
