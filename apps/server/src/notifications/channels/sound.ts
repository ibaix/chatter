import type { ChannelField } from '@local-chatter/shared';
import { z } from 'zod';

/**
 * The notification sound of a channel: one level for each message of the channel, also for a test.
 * The key is not "level", because the form already has a Level for the alerts that the channel gets.
 */
const LABELS = { quiet: 'Quiet', normal: 'Normal', high: 'High', urgent: 'Urgent' } as const;
type Sound = keyof typeof LABELS;

/** The field of the form. Normal is the first value of a new form. */
export function soundField(sounds: readonly Sound[], hint: string): ChannelField {
  return {
    key: 'sound', label: 'Notification sound', kind: 'choice', required: false, default: 'normal', hint,
    options: sounds.map(value => ({ value, label: LABELS[value] })),
  };
}

/** A channel saved before the field was there has no value, so it gets Normal with no change to the database */
export function soundSetting<const Sounds extends readonly [Sound, ...Sound[]]>(sounds: Sounds) {
  const names = sounds.map(sound => LABELS[sound]);
  const error = `Notification sound must be ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return z.enum(sounds, { error }).default('normal' as Sounds[number]);
}
