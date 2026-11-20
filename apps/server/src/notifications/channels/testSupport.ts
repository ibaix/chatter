import type { OutgoingMessage, SendContext, SendResult } from './ChannelType.js';

/** A warning alert that started, with a machine and a link. The tests of the channel types send it. */
export const WARNING_MESSAGE: OutgoingMessage = {
  kind: 'started',
  text: 'WARNING - Haas ST-10: Idle for 20 minutes. Started 9:40 AM.',
  severity: 'warning',
  machine: { id: 'haas-st10', name: 'Haas ST-10' },
  alertName: 'Idle for 20 minutes',
  summary: 'Idle for 20 min or more',
  startedAt: '2026-11-13T15:40:00.000Z',
  endedAt: null,
  link: 'http://chatter.local:3001/machine/haas-st10',
};

export interface SentRequest {
  url: string;
  init: RequestInit;
}

/** A fetch that keeps each request and gives the answer of `answer` for the request. No test sends a real message. */
export function fakeFetch(answer: (request: SentRequest) => Response | Promise<Response>) {
  const requests: SentRequest[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const request = { url: String(url), init };
    requests.push(request);
    return answer(request);
  }) as typeof globalThis.fetch;
  return { requests, context: (): SendContext => ({ fetch, signal: new AbortController().signal }) };
}

/** The text that the message list shows for the result */
export function textOf(result: SendResult): string {
  return result.ok ? result.detail : result.error;
}
