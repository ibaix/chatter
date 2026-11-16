import koffi from 'koffi';
import { describe, expect, it } from 'vitest';
import { EXEPRG_PATH, LOADELM, ODBACT, ODBACT2, ODBALMMSG_DATA, ODBEXEPRG, ODBM, ODBSPLOAD, ODBSPLOAD_ALL, ODBST, ODBSYS, toFocasMacro, toFocasStatus, toSpindleLoadPercent, toSpindles, toSystemInfo } from './focas.js';

describe('ODBST, the reply of cnc_statinfo', () => {
  // The layout of 0i, 16i/18i/21i, 30i/31i/32i and Power Mate i in fwlib32.h: 9 shorts.
  // (Series 15 has another layout. A wrong layout reads each field from the wrong place.)
  it('has the fields of the 0i and 30i controls at their places', () => {
    expect(koffi.sizeof(ODBST)).toBe(18);
    expect(koffi.offsetof(ODBST, 'aut')).toBe(4);
    expect(koffi.offsetof(ODBST, 'run')).toBe(6);
    expect(koffi.offsetof(ODBST, 'motion')).toBe(8);
    expect(koffi.offsetof(ODBST, 'mstb')).toBe(10);
    expect(koffi.offsetof(ODBST, 'emergency')).toBe(12);
    expect(koffi.offsetof(ODBST, 'alarm')).toBe(14);
    expect(koffi.offsetof(ODBST, 'edit')).toBe(16);
  });
});

describe('toFocasStatus', () => {
  const reply = { hdck: 0, tmmode: 0, aut: 1, run: 3, motion: 1, mstb: 0, emergency: 0, alarm: 0, edit: 0 };

  it('gives START while a program runs', () => {
    expect(toFocasStatus(reply).runState).toBe('START');
    expect(toFocasStatus({ ...reply, run: 2 }).runState).toBe('HOLD');
  });

  it('gives the mode names of the 0i and 30i controls, where 2 is not used and 3 is EDIT', () => {
    expect(toFocasStatus(reply).mode).toBe('MEMORY');
    expect(toFocasStatus({ ...reply, aut: 3 }).mode).toBe('EDIT');
    expect(toFocasStatus({ ...reply, aut: 5 }).mode).toBe('JOG');
    expect(toFocasStatus({ ...reply, aut: 10 }).mode).toBe('REMOTE');
    expect(toFocasStatus({ ...reply, aut: 2 }).mode).toBe('UNKNOWN_2');
  });

  it('gives the emergency stop and the alarm from their own fields', () => {
    expect(toFocasStatus({ ...reply, emergency: 1 }).emergency).toBe(true);
    expect(toFocasStatus({ ...reply, alarm: 1 }).alarm).toBe(true);
    expect(toFocasStatus(reply)).toMatchObject({ emergency: false, alarm: false, emergencyStatus: 0, alarmStatus: 0 });
    expect(toFocasStatus(reply).warning).toBeUndefined();
    expect(toFocasStatus({ ...reply, alarm: 1 }).warning).toBeUndefined();
  });

  it('does not take RESET (2) or WAIT (3) of ODBST.emergency for an emergency stop, and keeps the code', () => {
    expect(toFocasStatus({ ...reply, emergency: 2 })).toMatchObject({ emergency: false, emergencyStatus: 2 });
    expect(toFocasStatus({ ...reply, emergency: 3 })).toMatchObject({ emergency: false, emergencyStatus: 3 });
  });

  it('gives a warning, not an alarm, for the ODBST.alarm codes above ALM', () => {
    expect(toFocasStatus({ ...reply, alarm: 2 })).toMatchObject({ alarm: false, alarmStatus: 2, warning: 'Battery low' });
    expect(toFocasStatus({ ...reply, alarm: 3 })).toMatchObject({ alarm: false, alarmStatus: 3, warning: 'Fan' });
    expect(toFocasStatus({ ...reply, alarm: 8 })).toMatchObject({ alarm: false, warning: 'PMC alarm' });
    expect(toFocasStatus({ ...reply, alarm: 12 })).toMatchObject({ alarm: false, warning: 'Warning (status 12)' });
  });
});

describe('ODBSPLOAD, the reply of cnc_rdspmeter', () => {
  // fwlib32.h: LOADELM { long data; short dec; short unit; char name, suff1, suff2, reserve }.
  // Chatter reads a long as 32 bits, the same as for cnc_acts.
  it('has the load meter first and the speed meter after it, 12 bytes each', () => {
    expect(koffi.sizeof(LOADELM)).toBe(12);
    expect(koffi.offsetof(LOADELM, 'dec')).toBe(4);
    expect(koffi.offsetof(LOADELM, 'unit')).toBe(6);
    expect(koffi.offsetof(LOADELM, 'name')).toBe(8);
    expect(koffi.sizeof(ODBSPLOAD)).toBe(24);
    expect(koffi.offsetof(ODBSPLOAD, 'spspeed')).toBe(12);
  });
});

describe('the FOCAS long, 32 bits on every platform', () => {
  // The offsets that libfwlib32-linux-x64.so.1.0.5 writes to (see the comment above the structures in focas.ts).
  // koffi's own "long" would be 8 bytes on 64-bit Linux, and would move every field after it.
  it('puts ODBACT.data at offset 4, as cnc_acts writes it', () => {
    expect(koffi.offsetof(ODBACT, 'data')).toBe(4);
    expect(koffi.sizeof(ODBACT)).toBe(8);
  });

  it('puts ODBM.mcr_val at offset 4 and dec_val at offset 8, as cnc_rdmacro writes them', () => {
    expect(koffi.offsetof(ODBM, 'mcr_val')).toBe(4);
    expect(koffi.offsetof(ODBM, 'dec_val')).toBe(8);
  });

  it('puts ODBEXEPRG.o_num at offset 36, as cnc_exeprgname writes it', () => {
    expect(koffi.offsetof(ODBEXEPRG, 'o_num')).toBe(36);
  });

  it('gives each alarm of cnc_rdalmmsg 44 bytes', () => {
    expect(koffi.sizeof(ODBALMMSG_DATA)).toBe(44);
  });
});

describe('ODBSYS, the reply of cnc_sysinfo', () => {
  it('has the fields of every control but Series 15 at their places', () => {
    expect(koffi.sizeof(ODBSYS)).toBe(18);
    expect(koffi.offsetof(ODBSYS, 'cnc_type')).toBe(4);
    expect(koffi.offsetof(ODBSYS, 'mt_type')).toBe(6);
    expect(koffi.offsetof(ODBSYS, 'series')).toBe(8);
    expect(koffi.offsetof(ODBSYS, 'version')).toBe(12);
    expect(koffi.offsetof(ODBSYS, 'axes')).toBe(16);
  });

  it('gives the series and type as text, without the spaces', () => {
    const info = toSystemInfo({ max_axis: 32, cnc_type: ' 0', mt_type: ' T', series: 'D4F1', version: '0010' });
    expect(info).toEqual({ cncType: '0', mtType: 'T', series: 'D4F1', version: '0010', maxAxes: 32 });
  });
});

describe('toSpindleLoadPercent', () => {
  const meter = (data: number, dec: number, unit = 0) => ({
    spload: { data, dec, unit, name: 83, suff1: 49, suff2: 0, reserve: 0 },
    spspeed: { data: 0, dec: 0, unit: 2, name: 83, suff1: 49, suff2: 0, reserve: 0 },
  });

  it('gives the load in percent from the number and its decimal places', () => {
    expect(toSpindleLoadPercent(1, meter(375, 1))).toBe(37.5);
    expect(toSpindleLoadPercent(1, meter(0, 0))).toBe(0);
  });

  it('gives no load when the control read no spindle, for example an analog spindle', () => {
    expect(toSpindleLoadPercent(0, meter(375, 1))).toBeUndefined();
  });

  it('gives no load when the unit is not percent', () => {
    expect(toSpindleLoadPercent(1, meter(375, 1, 1))).toBeUndefined();
  });
});

describe('toFocasMacro', () => {
  // Values read from a 0i-M: #4120 (the tool), #3901 and #3902 (the part counts)
  it('gives mcr_val with dec_val decimal places', () => {
    expect(toFocasMacro({ datano: 4120, mcr_val: 200000000, dec_val: 8 }).value).toBe(2);
    expect(toFocasMacro({ datano: 3901, mcr_val: 460000000, dec_val: 7 }).value).toBe(46);
    expect(toFocasMacro({ datano: 500, mcr_val: 12345, dec_val: 2 }).value).toBe(123.45);
  });

  it('keeps a real 0 as 0', () => {
    expect(toFocasMacro({ datano: 3902, mcr_val: 0, dec_val: 0 }).value).toBe(0);
  });

  it('gives no value for a vacant variable (mcr_val 0, dec_val -1), not 0', () => {
    expect(toFocasMacro({ datano: 500, mcr_val: 0, dec_val: -1 })).toEqual({ number: 500, value: undefined, decimalPlaces: -1 });
  });
});

describe('the replies for every spindle of a path', () => {
  // fwlib32.h: ODBACT2 { short datano; short type; long data[MAX_SPINDLE] }, MAX_SPINDLE 8 on the 30i series
  it('puts the speeds of cnc_acts2 at offset 4, 4 bytes each', () => {
    expect(koffi.offsetof(ODBACT2, 'data')).toBe(4);
    expect(koffi.sizeof(ODBACT2)).toBe(36);
  });

  it('gives cnc_rdspmeter room for 8 spindles of 24 bytes each', () => {
    expect(koffi.sizeof(ODBSPLOAD_ALL)).toBe(8 * 24);
    expect(koffi.offsetof(ODBSPLOAD_ALL, 'msg2')).toBe(24);
  });

  it('gives cnc_exeprgname2 256 characters for the full program name', () => {
    expect(koffi.sizeof(EXEPRG_PATH)).toBe(256);
  });
});

describe('toSpindles', () => {
  const S = 83;
  const digit = (n: number) => 48 + n;
  const meter = (suffix: number, load: number, speed: number, loadUnit = 0) => ({
    spload: { data: load, dec: 0, unit: loadUnit, name: S, suff1: digit(suffix), suff2: 0 },
    spspeed: { data: speed, dec: 0, unit: 1 },
  });

  // A FANUC 0i-TT (two paths), as probed: cnc_acts2(-1) fills only the first N speeds, N = the spindles of the path
  it('keeps only the speeds of the spindles that cnc_rdspmeter read, not the garbage after them', () => {
    const path1 = toSpindles([meter(1, 0, 0), meter(2, 0, 0)], [0, 0, 0, 8276, 5, 0, 0, 8276]);
    expect(path1).toEqual([
      { name: 'S1', speed: 0, load: 0 },
      { name: 'S2', speed: 0, load: 0 },
    ]);

    // Path 2 (the sub-spindle S3), turning at 500 rpm after an MDI command
    expect(toSpindles([meter(3, 84, 500)], [500, 0, 0, 8276, 5, 0, 0, 8276])).toEqual([{ name: 'S3', speed: 500, load: 84 }]);
  });

  it('gives the load with its decimal places, and no load in another unit', () => {
    const tenths = meter(1, 375, 0);
    tenths.spload.dec = 1;
    expect(toSpindles([tenths], [100])[0].load).toBe(37.5);
    expect(toSpindles([meter(1, 375, 0, 1)], [100])[0].load).toBeUndefined();
  });

  it('leaves out characters that are not letters or digits from the name, and numbers a spindle with no name', () => {
    const garbled = meter(1, 0, 0);
    garbled.spload.suff2 = 0x01;
    expect(toSpindles([garbled], [0])[0].name).toBe('S1');
    const unnamed = meter(1, 0, 0);
    unnamed.spload.name = 0;
    unnamed.spload.suff1 = 0;
    expect(toSpindles([meter(1, 0, 0), unnamed], [0, 0])[1].name).toBe('S2');
  });

  it('gives no speed for a spindle that cnc_acts2 did not give', () => {
    expect(toSpindles([meter(1, 0, 0)], [])[0].speed).toBeUndefined();
  });
});
