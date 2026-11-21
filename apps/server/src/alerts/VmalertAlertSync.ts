import { z } from 'zod';
import { createLogger } from '../logging/logger.js';
import { textUpTo } from '../notifications/channels/http.js';
import type { AlertStore, VmalertState } from './AlertStore.js';

const log = createLogger('alerts');

const RULES_PATH = '/api/v1/rules?type=alert';
/** Also once at the start. A resolve that vmalert could not send ends the alert within this time, not after the grace time. */
export const SYNC_INTERVAL_MS = 2 * 60_000;
const SYNC_TIMEOUT_MS = 5000;
/** About 4 KB for each rule with an alert, so this is about 1000 rules. A Pi can have 512 MB of RAM. */
export const MAX_RULES_REPLY_BYTES = 4 * 1024 * 1024;

const rulesReply = z.object({
  data: z.object({
    groups: z.array(z.object({
      name: z.string(),
      rules: z.array(z.object({
        name: z.string(),
        /** "0001-01-01T00:00:00Z" before the first check */
        lastEvaluation: z.string().optional(),
        alerts: z.array(z.object({ state: z.string(), labels: z.record(z.string(), z.string()) })).nullish(),
      })),
    })),
  }),
});

export interface VmalertAlertSyncOptions {
  /** The vmalert address, for example http://vmalert:8880. vmalert has no login, so it must stay on the inside network. */
  url: string;
  store: AlertStore;
  /** Runs after each sync, for example to send the messages of the alerts that ended */
  afterSync?: () => void;
  /** Tests give a fake fetch */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * vmalert sends each firing alert again at each check, but it sends a resolve one time only.
 * When Chatter cannot get that send (for example, while it restarts), the alert would fire until the grace time ends.
 * So Chatter reads the alerts that vmalert has now, at the start and every 2 minutes (AlertStore.updateFromVmalert).
 */
export class VmalertAlertSync {
  private readonly rulesUrl: string;
  private readonly store: AlertStore;
  private readonly afterSync: () => void;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private lastProblem = '';

  constructor({ url, store, afterSync = () => {}, fetch = globalThis.fetch, now = Date.now }: VmalertAlertSyncOptions) {
    this.rulesUrl = new URL(RULES_PATH, url).href;
    this.store = store;
    this.afterSync = afterSync;
    this.fetch = fetch;
    this.now = now;
  }

  start(): void {
    if (this.timer) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** True when Chatter read the alerts of vmalert. It never throws. */
  async syncNow(): Promise<boolean> {
    let state: VmalertState;
    try {
      state = await this.readState();
    } catch (error) {
      this.reportProblem(error instanceof Error && error.cause instanceof Error ? `${error.message} (${error.cause.message})` : String(error));
      return false;
    }
    try {
      const { renewed, ended } = this.store.updateFromVmalert(state, this.now());
      if (renewed + ended > 0) log.info('Updated the alerts from vmalert', { renewed, ended });
      this.afterSync();
    } catch (error) {
      log.error('Could not update the alerts from vmalert', { error });
      return false;
    }
    this.reportWorksAgain();
    return true;
  }

  private async readState(): Promise<VmalertState> {
    const response = await this.fetch(this.rulesUrl, { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
    const text = await textUpTo(response, MAX_RULES_REPLY_BYTES);
    if (!response.ok) throw new Error(`vmalert answered ${response.status}`);
    if (text === undefined) throw new Error('The reply of vmalert is too large, or it stopped before its end');
    const parsed = rulesReply.safeParse(parseJson(text));
    if (!parsed.success) throw new Error('The reply of vmalert has an unknown form');
    return toState(parsed.data);
  }

  /** Each new kind of problem once, so a long stop of vmalert does not fill the log */
  private reportProblem(problem: string): void {
    if (problem !== this.lastProblem) log.warn('Could not read the alerts of vmalert. Chatter tries again in 2 minutes', { url: this.rulesUrl, problem });
    this.lastProblem = problem;
  }

  private reportWorksAgain(): void {
    if (!this.lastProblem) return;
    log.info('Reading the alerts of vmalert works again');
    this.lastProblem = '';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toState(reply: z.output<typeof rulesReply>): VmalertState {
  const state: VmalertState = { firing: [], lastChecks: new Map() };
  for (const group of reply.data.groups) {
    for (const rule of group.rules) {
      const lastCheck = Date.parse(rule.lastEvaluation ?? '');
      if (!Number.isNaN(lastCheck)) state.lastChecks.set(`${group.name}\n${rule.name}`, lastCheck);
      for (const alert of rule.alerts ?? []) {
        if (alert.state === 'firing') state.firing.push({ labels: alert.labels });
      }
    }
  }
  return state;
}
