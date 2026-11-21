/** Settings > Diagnostics and the connection test of a machine */

/** ok: the step worked. failed: the step shows the problem. warning: a problem that does not stop the machine data. skipped: not done. */
export type TestResult = 'ok' | 'failed' | 'warning' | 'skipped';

/** One step of a connection test. Each text is fixed in Chatter: no text from the machine is shown. */
export interface ConnectionTestStep {
  /** "Address", "Port 10000 (data)" or "Answer" */
  name: string;
  result: TestResult;
  text: string;
  /** What to do next, when the step shows a problem */
  hint?: string;
}

/** POST /api/machine/:id/test */
export interface ConnectionTestReport {
  /** The saved host that the test used */
  host: string;
  /** ISO text */
  testedAt: string;
  steps: ConnectionTestStep[];
}
