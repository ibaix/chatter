# Security

## Report a security problem

Do not open a public issue for a security problem. Other people can read it before a fix is ready.
Open the **Security** tab of the repo, click **Report a vulnerability**, and fill in the form. Tell us:
- What the problem is, and what an attacker can do with it
- The steps to make it happen
- The Chatter version
- How you run Chatter (the Pi card or Docker, and the operating system)

We fix security problems only in the newest version. To get a fix, [update Chatter](./guide/update.md).

## How Chatter is made to be used

Chatter is made for a **shop network that you trust**, behind a firewall. Do not make it open to the internet.

These limits are known. They are not bugs, but you must know them:

- **Every computer on the network can open Chatter** on port 3001. Use a firewall rule if only some computers must reach it.
- **No HTTPS by itself.** Other people on the network can read the login cookie, and the password that a program sends. To use HTTPS, put a reverse proxy in front of Chatter (see [Use HTTPS](./guide/https.md)).
- **Chatter sends no HSTS header.** HSTS tells a browser to use only HTTPS for an address. On a LAN address with plain HTTP, it can lock the users out. If your proxy gives HTTPS, the proxy can send HSTS. Chatter sends the other security headers: other sites cannot show Chatter in a frame, and the page loads scripts only from Chatter.
- **Chatter accepts at most 256 connections at a time.** This keeps file handles free for the database, the log and the machines. A computer that sends no request in 20 seconds is disconnected. Each login can have 5 live update streams. When a login opens a 6th, its oldest stream closes. A computer on the network can still use all 256 connections, and then other browsers cannot open Chatter until it stops.
- **Trust only the address of your proxy** in **Settings > HTTPS and proxy**, or with `TRUST_PROXY`. A wrong address lets a computer hide its real address, and so get around the 15 minute wait after 10 wrong passwords. An Admin can end the wait for a computer in **Settings > Logins**.
- **FTP is not encrypted.** The FTP username, the FTP password, and the files go over the network as plain text.
- **The machines have no login on their data ports** (Brother, Haas, MTConnect, FANUC). Anyone on the network can read the machine data from those ports. A Siemens control has a login only if you set one up for OPC UA (see [Siemens machines](./guide/siemens.md)).
- **A login lasts 1 year.** Log out stops the login of that browser, also a copy of its cookie. To stop your other logins, use **Log out all other browsers** in **Settings > Your account**, or change your password. To log out a different user, an Admin sets a new password for that user.
- **Give each person their own account, with the smallest role that they need.** A Viewer can only look, and change their own password. An Operator can also send and delete files. An Admin can do everything.
- **The first visit sets up the first Admin.** Until an Admin exists, the first person who opens Chatter can make the Admin account. So set it up at once after you install.
- **Anyone on the network can see the Chatter version** at `/api/health`, with no login. The update helper needs it. It also gives a random name of the server process, which changes at each start. The network scan uses it to tell this Chatter from another one.
- **Chatter asks GitHub once a day for the newest version.** It sends no machine data. To stop this, turn off **Check for updates on GitHub** in **Settings > Updates**.
- **Chatter runs the FANUC FOCAS2 library as program code.** In **Settings > FANUC library**, upload only the files that you got from FANUC.
- **Notifications send alert text out of the shop network.** A message has the machine name, the alert, and the value, and can have the Chatter address. It goes to Twilio, to the web address of a webhook channel, to Discord, to Telegram, to an ntfy server, or to your Apprise server, which sends it on to your services. Only an Admin can add a channel. See [Notifications](./guide/notifications.md).

## Updates on the Pi card

Chatter itself cannot install an update. It only puts the update file and a request in a folder. A helper on the Pi, outside Docker, does the install.

- The helper installs only a file that is signed with the Chatter release key, and only a newer version. So a bad download or a bad upload cannot install.
- The helper does not trust anything that Chatter says or puts in the folder. So an attacker who breaks into Chatter cannot use the helper to take control of the Pi.
- A newer helper also accepts the request `reboot`, and restarts the Pi at most once in 15 minutes. So an attacker who breaks into Chatter can restart the Pi, but cannot keep it down.
- A newer helper writes `network.json` (the addresses of the Pi, the gateway, and if SSH is on) and `helper.log` for **Settings > Diagnostics**. It writes each value only when the value has the expected shape.

## Diagnostics

Only an Admin can use **Settings > Diagnostics** and the routes behind it: `/api/logs`, `/api/logs/stream`, `/api/logs/debug`, `/api/support-bundle`, `/api/system/facts`, `/api/system/restart-chatter`, `/api/system/restart-pi`, and `/api/updates/helper-log` (the role must manage updates).
Only an Admin can test or reconnect a machine: `/api/machine/:id/test` and `/api/machine/:id/reconnect` (the role must manage machines).
Each logged-in user can read the connection of a machine: `/api/machine/:id/health`.

- **The log hides secrets.** Before Chatter writes a line, it hides each value with a name such as password, token, secret, authorization, API key, or cookie, the user and password in an address, secret values in the query of an address, and the tokens in Telegram, Discord and Slack addresses. The log in memory, the log file, the log download, the live log, and the support bundle get only the hidden lines.
- **The support bundle hides the saved secrets, but not all text.** The machine settings lose each password field: they tell only if a password is saved. The notification channels have their type, name, and routing only: not their saved settings. The messages have their status and error, not their text. But an error text or a log line can contain an address, a topic, or a phone number. The support bundle is for your own support. Read it before you send it to another person.
- **The connection test uses only the saved address and ports of the machine.** The request has no address, so nobody can use it to reach another computer. Chatter allows one test of a machine at a time, and one in each 10 seconds. The texts are fixed: no text from the machine is shown. The test does not use ping.
- **The restarts are logged with the user name.** Restart Chatter ends the process, and Docker starts it again. Restart the Pi only writes the request `reboot` into the update inbox. The helper checks it as strictly as an update request (see below), restarts the Pi only when it does not check or install, and at most once in 15 minutes.
- **The live log has limits**, so a forgotten browser tab cannot fill the memory of the Pi: at most 3 live logs, and 200 waiting lines for each. A slow browser loses lines, and Chatter tells how many.
- **The log file** is in the data volume, next to `chatter.db` (`logs/chatter.log`, at most 2 files of 1 MB).

## History backup of a machine

The **Advanced** panel of the Settings tab of a machine backs up its history to a file, and restores such a file (see [Back up and restore the history of a machine](./guide/get-started.md#back-up-and-restore-the-history-of-a-machine)).

- **The file has no secrets.** It has no machine settings: no address, port, user name, password, or macro. The manifest has only the id, the name, and the type of the machine. The alert rules are in it. A custom alert query can name other machines, so read the rules before you give the file to another person.
- **Only an Admin can restore.** A user with `manage-machines` can back up. Chatter logs each backup and restore with the user name.
- **Chatter checks all of a file before it writes anything.** It takes only the known entries, each with the size and sha256 of the manifest, and it never uses a name from the file as a path. A restore writes only `chatter_*` series with the labels `__name__`, `machine` and `type`, and changes only their `machine` label. It refuses a series with another label, or of another machine than the manifest names. So a file cannot change the history of another machine or the alert state of vmalert. Anyone who can edit the file can make the sha256 match again, so the check finds a broken file, not a changed one. An Admin must restore only files that they trust.
- **The limits protect the Pi.** A file is at most 2 GB, a line at most 1 MB, and a part at most 16 GB after unpacking. Chatter streams the upload and the download to the disk of the data volume (`history-backup/`), not into memory, and keeps 256 MB of the disk free. A backup can use only the free space of the disk. Only one backup or restore runs at a time. Chatter deletes these files at the end, after 30 minutes with no next step, when a request or a download stops, and at each start.
- **VictoriaMetrics exports block by block** (`reduce_mem_usage=1`), so the export of a long history does not fill the memory of the Pi.

## Keep `chatter.db` private

`chatter.db` is the database file. With Docker, it is in the volume `chatterbox-data`. It holds:

- The FTP passwords of the machines and the OPC UA passwords of Siemens machines, as plain text, because Chatter must send them to the machines.
- The Twilio auth tokens, the webhook secrets, the Discord webhook addresses, the Telegram bot tokens, the ntfy topics and access tokens, and the Apprise passwords of the notification channels, as plain text, because Chatter must send them to the service. Anyone with the file can send text messages with your Twilio account, can post to your Discord channel, can send messages with your Telegram bot, and can read and send to your ntfy topic.
- The usernames and roles. Each password is kept only as a hash (a one-way code, so nobody can read the password back from it).
- The logged-in browsers and the last 50 password tries, with their addresses. A login cookie is kept only as a hash, so the file cannot be used to log in.

The folder `opcua-pki` next to `chatter.db` holds the private key of the Chatter certificate for Siemens machines.

Do not share these files. Keep their backups private, and also the backups of the machine history (the volume `victoriametrics-data`).

## Keep VictoriaMetrics and vmalert closed

VictoriaMetrics (the machine history database) and vmalert have no login. Anyone who reaches them can read and delete the machine history. Chatter's alert port 3002 has no login either: anyone who reaches it can add false alerts.

- `docker-compose.yml` does not publish these ports, so only Chatter can reach them. Do not add a `ports:` line for `victoriametrics` or `vmalert`, or for port 3002 of `chatterbox`.
- Without Docker, Chatter listens on port 3002 only on `127.0.0.1`. Change `ALERT_HOST` only to an address that other computers cannot reach.

Only an Admin can change the alert rules. A custom alert query can only read the machine history. It cannot change or delete data.

## Forgot a password

An Admin sets a new one in **Settings > Users and roles**, with **Reset password**.

If no Admin knows their password, run this in the Chatter folder, then open Chatter and make a new Admin account at once:
```bash
docker compose exec chatterbox npm run reset-password
```
On the Raspberry Pi card, first run `cd /opt/chatter`, and put `sudo` before `docker`.

This removes the Admin accounts and logs out every browser. The Viewer and Operator accounts, your machines, and the upload history stay.

## Not in scope

- Problems in the machine controls, or in their own protocols
- Problems in the FANUC FOCAS2 library (report them to FANUC)
- Attacks that need access to the computer that runs Chatter, or to `chatter.db`
