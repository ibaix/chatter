# Notifications

Chatter can send a message when a machine alert starts and when it ends.
The message goes to a **channel**: the phones of the shop as text messages (Twilio), a web address (a webhook), for example Slack, ntfy, or Home Assistant, or an Apprise server, which sends it on to Teams, Discord, Telegram, email, and many more services.

You set up the channels in **Settings > Notifications**. Only an **Admin** can see this tab.
To make the alerts themselves, see [Alerts](./alerts.md).

## What a message says

| When | Example |
| --- | --- |
| An alert starts | `CRITICAL - Haas VF-2: Spindle load above 80%. Spindle load is 92%. Started 9:02 AM.` |
| The alert ends | `OK - Haas VF-2: Spindle load above 80% ended at 9:40 AM.` |
| The alert started and ended before Chatter could send the first message | `CRITICAL - Haas VF-2: Spindle load above 80% started 9:02 AM and ended 9:40 AM.` |
| A channel got too many messages | `And 7 more alerts. Open Chatter to see them.` |
| You click **Send test** | `Test from Chatter. Messages to this channel work.` |

The message starts with `CRITICAL` or `WARNING` when an alert starts (`ALERT` when the alert has no known level), and with `OK` when it ends.

## Set up the message settings

The **Message settings** panel is at the bottom of the tab.

- **Chatter address for links:** the address that people type to open Chatter, for example `http://chatter.local:3001`. Each message then ends with a link to the machine page, or to Chatter when the message is not about one machine. Leave it empty to send no link.
- **Time zone:** the time zone of the shop, for example `America/Chicago`. The times in the messages use it. The first time, Chatter fills in the time zone of your browser. Click **Save settings** to keep it. Without a time zone, the messages use UTC and say "UTC".

## Add a channel

1. Click **Add channel**.
2. Select the **Type**, and type a **Name**, for example "Shop phones".
3. Fill in the boxes of the type. See [Text messages with Twilio](#text-messages-with-twilio), [Webhooks](#webhooks), or [Apprise](#apprise).
4. Under **Which alerts**, select:
   - **Level:** **Warning and up** sends each alert. **Critical only** sends only the critical alerts.
   - **Machines:** **All machines, also the machines that you add later** sends the alerts of each machine, now and later. **Pick machines** sends only the alerts of the machines that you select.
5. Click **Send test**. The result shows under the form. Fix the problem if the test fails.
6. Click **Save channel**.

Each alert sends 2 messages: one when it starts, and one when it ends.

## Change, turn off, or delete a channel

- The switch in the **On** column turns a channel off or on. A channel that is off keeps its settings, but it gets no messages.
- **Send test** in the row sends a test message with the saved settings.
- **Edit** opens the channel. Change it, then click **Save channel**.
- To delete a channel, click **Edit**, then **Delete channel**, then **Delete the channel**. Chatter stops its waiting messages. Its sent and failed messages stay in the message list as **Deleted channel**, until Chatter removes them.

After you save, Chatter never shows a secret again, such as the Twilio auth token or the Apprise password. To keep the saved secret, leave its box empty.
To change it, type the new one. To stop sending a webhook secret, select **Delete the saved secret**.

## Text messages with Twilio

[Twilio](https://www.twilio.com) is a service that sends text messages. You need your own Twilio account. Twilio asks a small price for each message.

1. Make a Twilio account, upgrade it from the trial, and get a phone number that can send SMS.
2. On the Twilio Console home page, copy the **Account SID** and the **Auth token**.
3. In Chatter, add a channel of the type **Text message (Twilio)**:
   - **Account SID** and **Auth token:** from step 2.
   - **From number:** your Twilio number, with `+` and the country code, for example `+15551230000`.
   - **Phone numbers:** the phones that get the messages, also with `+` and the country code. Click **Add a number** for each phone. A channel can have at most 20 numbers.

### Before the first message

- **Upgrade the Twilio account.** A Twilio trial account can send only the message templates of Twilio, not the messages of Chatter (error 572006).
- **In the US, register your number for A2P 10DLC.** A2P 10DLC is the US rule for text messages that a program sends from a normal phone number. Do the registration in the Twilio Console. It can take some days.
  Before the registration, Twilio takes each message, but does not deliver it. Chatter then shows **Sent**, but the phones get nothing. The Twilio message logs show error 30034.
- **A phone that sent STOP gets no messages** (error 21610). The phone can send START to your Twilio number to get them again.

## Webhooks

A webhook channel sends each message as JSON to a web address, with `POST`:

```json
{
  "text": "CRITICAL - Haas VF-2: Spindle load above 80%. Spindle load is 92%. Started 9:02 AM.",
  "state": "started",
  "level": "critical",
  "machine": { "id": "haas-vf2", "name": "Haas VF-2" },
  "alert": "Spindle load above 80%",
  "summary": "Spindle load is 92%",
  "startedAt": "2026-11-13T15:02:00.000Z",
  "endedAt": null,
  "link": "http://chatter.local:3001/machine/haas-vf2"
}
```

- `state` is `started`, `ended`, `combined` (started and ended), `more` (an "And 7 more alerts" message), or `test`.
- `level` is `warning`, `critical`, or `null` (for `more`, `test`, and an alert with an unknown level).
- `machine`, `alert`, `summary`, `startedAt`, `endedAt`, and `link` can be `null`.

If you type a **Secret (optional)**, Chatter sends it in the header `Authorization: Bearer <secret>`. Then the other app can check that the message is from Chatter.

### Slack

1. In Slack, make an app with an **incoming webhook** for your channel, and copy its address. It starts with `https://hooks.slack.com/`.
2. In Chatter, add a **Webhook** channel, and paste the address in **Web address**. Leave **Secret** empty.

Slack shows the `text` line.

### ntfy

[ntfy](https://ntfy.sh) sends push messages to the ntfy app on a phone. ntfy can show one field of the JSON, so add <code v-pre>?tpl=yes&amp;m={{.text}}</code> to the address of your topic:

```
https://ntfy.sh/your-topic?tpl=yes&m={{.text}}
```

Use a topic name that other people cannot guess. If your topic needs a login, put an ntfy access token in **Secret**.

### Home Assistant

1. In Home Assistant, make an automation with a **Webhook** trigger, and copy its webhook address, for example `http://homeassistant.local:8123/api/webhook/chatter-alerts`.
2. In Chatter, add a **Webhook** channel with that address. Leave **Secret** empty.

In the automation, `trigger.json.text` is the message, and `trigger.json.machine.name` is the machine name.

## Apprise

[Apprise](https://github.com/caronc/apprise) sends one message to more than 100 services, for example Microsoft Teams, Discord, Telegram, email, Pushover, and Signal.
Chatter sends each message to **Apprise API**, a small server that you run in the shop. Apprise then sends it to your services.
The logins of your services stay in Apprise, not in Chatter.

Apprise API runs on a computer with a 64-bit processor (Intel, AMD, or 64-bit ARM). It does not run on the Chatter Raspberry Pi card, so put it on another computer.

1. Start Apprise API with Docker, for example with this `docker-compose.yml`:

   ```yaml
   services:
     apprise:
       image: caronc/apprise:latest
       ports:
         - "8000:8000"
       environment:
         APPRISE_STATEFUL_MODE: simple
       volumes:
         - ./config:/config
       restart: unless-stopped
   ```

2. Open Apprise in a browser, for example `http://apprise.local:8000`. Save the addresses of your services under a **config key**, for example `chatter`.
   Each service has its own address form, for example `tgram://bottoken/ChatID` for Telegram. The [Apprise wiki](https://github.com/caronc/apprise/wiki) has the form of each service.
3. In Apprise, send a test to the config key. Make sure that each service gets it.
4. In Chatter, add a channel of the type **Apprise**:
   - **Apprise address:** the Apprise address, then `/notify/`, then your config key, for example `http://apprise.local:8000/notify/chatter`.
   - **Tag (optional):** sends only to the services that have this tag in Apprise. Leave it empty to send to the services with no tag. Type `all` to send to each service.
   - **User name** and **Password (optional):** only when your Apprise asks for a login (`APPRISE_AUTH_REQUIRED=yes`).
5. Click **Send test**.

Chatter gives each message an Apprise type, so each service can show it with its own color or icon:

| Message | Apprise type |
| --- | --- |
| A critical alert starts | `failure` |
| A warning alert starts, or an "And more alerts" message | `warning` |
| An alert ends | `success` |
| A test | `info` |

The title is `Chatter: ` and the machine name, for example the subject of an email. The text is the same as in a text message.

Apprise answers only after it sent the message to each service. So Chatter waits up to 60 seconds for Apprise. For the other types, it waits 10 seconds.
If Apprise does not answer in 60 seconds, Chatter tries again later. Then a service that already got the message can get it two times.

## The message list

The **Messages** panel shows each message of the last 30 days, the newest first. Chatter keeps at most 1000 messages, so a busy shop sees fewer days. Select a channel in **Channel** to see only its messages.

| Result | Meaning |
| --- | --- |
| **Sent** | The service took the message. Under it is the answer of the service, for example "Sent to 2 phones". Twilio can still fail to deliver a text after that. |
| **Waiting** | Chatter sends it soon, or tries again soon. |
| **Failed** | Chatter did not send it. Under it is the reason. |
| **In an "And more alerts" message** | The channel got too many messages, so this alert went in an "And N more alerts" message. |

## Check

| What you see | What to do |
| --- | --- |
| No message comes when an alert starts | Check that the channel is **On**, and that its **Level** and **Machines** include the alert. Then look in the message list. |
| **Failed:** Twilio refused the login | The Account SID or the auth token is wrong. Copy them again from the Twilio Console. |
| **Sent**, but the phone gets no text | **Sent** means only that Twilio took the message. In the Twilio Console, open **Monitor > Logs > Messaging** and look at the status of the message. Error 30034 means that your US number is not registered for A2P 10DLC. See [Before the first message](#before-the-first-message). |
| **Failed:** a Twilio trial account can send only the message templates of Twilio | Upgrade the Twilio account. |
| **Failed:** a number is not verified | An old Twilio trial account sends only to verified numbers. Verify the number in Twilio, or upgrade the account. |
| **Failed:** Sent to 1 of 2 phones | One number has a problem. For a wrong or blocked number, the reason tells which one. Chatter does not try again, so no phone gets the message two times. |
| **Failed:** the address answered 404 | The web address is wrong. Copy it again. |
| **Failed:** the address answered 401 or 403 | The secret is wrong, or the app needs one. |
| **Failed:** the address points to another address | Chatter does not follow a redirect. Use the new address, for example `https://` in place of `http://`. |
| **Failed:** Apprise could not send to one service or more | One of your services in Apprise failed, or no service has the tag. Look in the Apprise log. Chatter does not try again, so no service gets the message two times. |
| **Failed:** Apprise has no config with this key | The config key in the **Apprise address** is wrong, or you did not save the config in Apprise. |
| **Failed:** Apprise refused the login | Type the user name and password of Apprise. |
| **Failed:** Chatter could not reach Apprise | Apprise API is not running, or the address is wrong. Chatter tries again for 24 hours. |
| **Waiting:** Apprise did not answer in time | Apprise needs more than 60 seconds to send to your services. Look in the Apprise log for a slow service. Chatter tries again later. |
| **Waiting:** Apprise answered 500 (or 502, 503, 429) | Apprise or one of its parts has a problem, or is busy. Look in the Apprise log. Chatter tries again for 24 hours. |
| **Waiting** for a long time | The service does not answer, or answers with an error that can go away. Chatter tries again for 24 hours, then the message fails. |
| An "And 7 more alerts" message | A channel gets at most 10 messages in 10 minutes. Chatter puts the other alerts in one message. Make fewer alerts fire, or select **Critical only**. |
| The times are in UTC | Set the **Time zone** in **Message settings**. |
| The messages have no link | Set **Chatter address for links** in **Message settings**. |

## How it works

When an alert starts or ends, Chatter makes one message for each channel that wants the alert.
The message waits in a queue in `chatter.db`.
After a restart or a power cut, the message is still in the queue, and Chatter sends it.
If the end of an alert comes before Chatter sent its start, Chatter sends one message for both.
A channel that did not get the start of an alert gets no end message for it, for example a channel that you add while the alert is on.

Sometimes the service does not answer, or answers that it is busy. Then Chatter tries the message again.
The waits are 30 seconds, 1 minute, 2 minutes, and 5 minutes, then 10 minutes each time. After 24 hours, the message fails.
It does not try again when the service refuses the message, for example for a wrong login, because the next try fails too.

Chatter keeps the Twilio auth token, the webhook secret, and the Apprise password in `chatter.db` as plain text, because it must send them to the service. See [Keep chatter.db private](../security.md#keep-chatter-db-private).

Chatter sends the messages directly to Twilio, to the web address, or to Apprise. It cannot send them through a proxy server yet.

To manage the channels from a program, see [Notifications API](../api/notifications.md).
