# Notifications

These endpoints are for an **Admin** only. Another role gets `403`.
For what notifications do, see [Notifications](../guide/notifications.md).

The server never sends a secret value back, such as the Twilio auth token, the webhook secret, the Apprise password, the Discord webhook address, the Telegram bot token, or the ntfy access token.
`hasSecret` tells which secrets have a saved value, for example `{ "authToken": true }`.

## Channel types

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notification-types` | The channel types that this Chatter knows, with the fields of their form |

Each type is `{ id, name, fields, note? }`. Each field is `{ key, label, kind, required, hint?, mono?, generate?, advanced?, options?, default? }`. With `generate: 'words'`, the form has a button that fills the box with three random words. With `advanced: true`, the form puts the field under a closed **Advanced** heading.
`kind` is `text`, `secret`, `url`, `phone-list`, or `choice`. The value of a `phone-list` field is a list of phone numbers. The value of each other field is one text.
A `choice` field has `options`, a list of `{ value, label }`, and the form shows it as a select. Its value is one of the `value` texts. `default` is the value that a new form starts with.
The `discord`, `telegram`, and `ntfy` types have the `choice` field `sound` (**Notification sound**), with the default `normal`. For `discord` and `telegram`, the options are `normal` and `quiet`. For `ntfy`, the options are `quiet`, `normal`, `high`, and `urgent`. A channel that has no `sound` value sends as `normal`.
The types are `twilio-sms`, `webhook`, `apprise`, `discord`, `telegram`, and `ntfy`.

## Channels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notification-channels` | The channels |
| POST | `/api/notification-channels` | Add a channel. `201` with the channel |
| PUT | `/api/notification-channels/:id` | Change a channel. `404` when it is not there |
| DELETE | `/api/notification-channels/:id` | Delete a channel and its waiting messages. Its sent and failed messages stay. `204`, or `404` when it is not there |
| POST | `/api/notification-channels/test` | Send a test message with a form that is not saved |
| POST | `/api/notification-channels/:id/test` | Send a test message with the form of a saved channel. The result goes in the message list. `404` when the channel is not there |

A channel is `{ id, type, name, settings, hasSecret, minSeverity, machineIds, ignorePatterns, enabled, createdAt }`. `settings` has the values that are not secret.

The body of POST, PUT, and the tests is a form:

```json
{
  "type": "twilio-sms",
  "name": "Shop phones",
  "values": {
    "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "authToken": "",
    "from": "+15551230000",
    "to": ["+15559870001", "+15559870002"]
  },
  "minSeverity": "critical",
  "machineIds": null,
  "ignorePatterns": ["Door open"],
  "enabled": true
}
```

- `values` has a value for each field of the type, also the secret fields.
- On PUT and on the test of a saved channel, an empty secret keeps the saved secret.
- `clearSecrets` (optional, on PUT and on the test of a saved channel) is a list of secret keys to delete, for example `["secret"]` to stop sending a webhook secret.
- `minSeverity` is `warning` (warning and critical alerts) or `critical` (only critical alerts).
- `machineIds` is `null` for all machines, also the machines that you add later, or a list of machine ids.
- `ignorePatterns` (optional) is a list of at most 20 patterns. The channel does not send a message whose text has one of the patterns. A pattern finds text in any part of the message, and upper case and lower case are the same. `*` finds any text, and `?` finds one character. Each pattern has at most 100 characters. The server removes the spaces around each pattern, and keeps each pattern only one time. It refuses an empty pattern, and a pattern of only `*` and `?`. See [Ignore some messages](../guide/notifications.md#ignore-some-messages).
  - On POST, no `ignorePatterns` gives a channel with no patterns.
  - On PUT, no `ignorePatterns` keeps the saved patterns. To delete all the patterns, send `[]`.

On POST and PUT, a wrong form gets `400` with `{ "error": "<the problem in plain words>" }`. A body larger than 64 KB gets `413`.

A test sends a real message at once, and gives `{ "ok": true, "detail": "Sent to 2 phones" }` or `{ "ok": false, "error": "<the reason>" }`.
A test of a form with a wrong value, for example a wrong phone number, gets `200` with `ok: false`. Only a body with a missing or wrong part, for example no `minSeverity`, gets `400`.

## Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notification-messages` | The messages of the last 30 days, the newest first. Chatter keeps at most 1000. `?channel=<id>` gives the messages of one channel |

Each message is `{ id, channelId, alertId, kind, machineId, severity, text, status, attempts, lastError, detail, createdAt, sentAt }`.

- `kind` is `started`, `ended`, `combined` (started and ended), `more` (an "And N more alerts" message, or a summary after the channel was blocked), or `test`.
- `status` is `waiting`, `sent`, `failed`, `grouped` (the alert went in a `more` message, or in the next message about the same event; `detail` tells which), or `ignored` (the text has an ignore pattern of the channel, so Chatter did not send it).
- For an `ignored` message, `detail` tells why, for example `Ignored by the pattern "Door open"`, or `Ignored, because the start of this alert was ignored`.
- `lastError` is the reason of the last failed try. `detail` is the answer of the service when it took the message.

## Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notification-settings` | `{ linkBaseUrl, timeZone }` |
| PUT | `/api/notification-settings` | Save them, and get the saved settings back. Empty text or `null` means not set. A wrong value gets `400` |

- `linkBaseUrl`: the address that people use to open Chatter, for example `http://chatter.local:3001`. It must start with `http://` or `https://`, with no user name or password. With `null`, the messages have no link.
- `timeZone`: a time zone name, for example `America/Chicago`. With `null`, the times in the messages are in UTC.
