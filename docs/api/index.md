# API overview

Chatter has an HTTP API. The web app uses it, and your own programs can use it too.
Each endpoint starts with `/api`. The default port is `3001`.

## Login

Every endpoint needs a Chatter login, except `/api/health` and `/api/auth/*`.
The web app logs in with a cookie. A program sends the username and password with each request (HTTP Basic):

```bash
curl -u <username>:<password> http://localhost:3001/api/machines
```

A request with no login, or a wrong login, gets `401`.
After 10 wrong passwords for one user from one address in 15 minutes, that address must wait before it can try that user again. During that wait, a password try for that user gets `429`.
After 30 wrong passwords for one user from all addresses in 15 minutes, a password try for that user gets `429` from each address.
Each wait ends 15 minutes after the first wrong password. Good logins do not count.
A browser where the user logged in before has a device cookie. With that cookie, `/api/auth/login` and `/api/auth/password` do not use the two limits above. They use a limit of 10 wrong passwords in 15 minutes for that browser. HTTP Basic logins have no device cookie. A new password and **Log out all other browsers** stop the device cookies of the other browsers of the user.
All IPv6 addresses in one /64 network count as one address.
Browsers that are logged in, and programs whose login worked before, keep working during a wait.
**Log out** stops the login of that browser only. To log out your other browsers, use **Log out all other browsers** in **Settings > Your account**, or change your password.

## Roles

Each user that is logged in can see the machines, their history, and the alerts, and the names of the files.
Some endpoints also need a role. A role that cannot do the action gets `403`:
- Downloading a file, and reading the text of a sent file, needs **Operator** or **Admin**.
- Sending and deleting files needs **Operator** or **Admin**.
- A read of the tool table now (`POST /api/machine/:id/tools/sync`) needs **Operator** or **Admin**.
- Adding, changing, or removing machines, the network scan, the MTConnect port scan, `/api/focas/*`, `/api/settings/*`, and `/api/updates/*` need **Admin**.

## Errors

An error reply has the form `{ "error": "<the reason>" }`.
- `400`: a bad request body, query, or path value.
- `404`: the machine (or other item) does not exist.
- `500`: an error in Chatter, or on the machine.

## The endpoints

- [Login and settings](./auth-and-settings.md): log in, log out, users, proxies, and login tries
- [Machines and files](./machines.md): the machine status, the machine list, the network scan, the program files, and the upload history
- [History and alerts](./history.md): values over time, periods, reports, and alerts
- [Notifications](./notifications.md): the channels that get the alert messages, the message list, and the message settings
- [FANUC library and updates](./admin.md): the FOCAS2 file, and updates on the Pi card
- [Live events](./live-events.md): live machine status with server-sent events
