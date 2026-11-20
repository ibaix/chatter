// ============================================
// When a machine counts as running
// ============================================

/**
 * The FANUC run states (ODBST.run) in which a program runs: START (automatic operation) and MSTR.
 * STOP and HOLD are not cutting, and RESET is not either.
 */
export const RUNNING_RUN_STATES: readonly string[] = ['START', 'MSTR'];

/** The MTConnect execution word (also used for Brother, Haas and Siemens) for a program that runs */
export const RUNNING_EXECUTION = 'ACTIVE';

/** The values that tell whether a machine runs */
export interface RunningValues {
  /** The FANUC run state: RESET, STOP, HOLD, START or MSTR */
  runState?: unknown;
  /** The MTConnect execution: ACTIVE, READY, FEED_HOLD, INTERRUPTED, STOPPED */
  execution?: unknown;
}

/**
 * True when the machine says a program runs. The dashboard and the machine history both use this rule.
 * Undefined when the machine tells neither a run state nor an execution.
 *
 * A turning spindle does not count: the spindle can turn while a program is held (HOLD, FEED_HOLD),
 * or in MDI or JOG with no program, and none of that is the machine running a job.
 */
export function isMachineRunning(values: RunningValues): boolean | undefined {
  if (typeof values.runState === 'string') return RUNNING_RUN_STATES.includes(values.runState);
  if (typeof values.execution === 'string') return values.execution === RUNNING_EXECUTION;
  return undefined;
}

/**
 * The FANUC run state after a program ends. M30 (and M02) reset the control, so the state is RESET.
 * STOP is an M00, M01 or single block stop, and HOLD is a feed hold: the program continues after them.
 */
export const PROGRAM_END_RUN_STATES: readonly string[] = ['RESET'];

/**
 * The execution words after a program ends. Brother, Haas and Siemens give the same words (READY when idle).
 * FEED_HOLD, INTERRUPTED, OPTIONAL_STOP, PROGRAM_STOPPED and WAIT are a pause, not an end.
 */
export const PROGRAM_END_EXECUTIONS: readonly string[] = ['READY', 'STOPPED', 'PROGRAM_COMPLETED'];

/** The values that tell whether a program ended */
export interface ProgramEndValues extends RunningValues {
  alarm?: unknown;
  emergency?: unknown;
}

/**
 * True while the control says that no program runs because the program ended, and not because of a hold,
 * an alarm or an emergency stop. Undefined when the machine tells neither a run state nor an execution.
 * The "Program ended" alert fires when this becomes true shortly after the machine ran.
 */
export function isProgramEnded(values: ProgramEndValues): boolean | undefined {
  const ended = values.alarm !== true && values.emergency !== true;
  if (typeof values.runState === 'string') return ended && PROGRAM_END_RUN_STATES.includes(values.runState);
  if (typeof values.execution === 'string') return ended && PROGRAM_END_EXECUTIONS.includes(values.execution);
  return undefined;
}

/**
 * The one run state of a FANUC control with several paths, such as a two-path lathe: the state of the
 * first path in which a program runs, else the state of the main path (the first one given).
 * So a machine runs when any of its paths runs, and isMachineRunning stays the one rule
 * of the dashboard and the machine history.
 */
export function combinedRunState(pathRunStates: readonly (string | undefined)[]): string | undefined {
  return pathRunStates.find(runState => runState !== undefined && RUNNING_RUN_STATES.includes(runState)) ?? pathRunStates[0];
}
