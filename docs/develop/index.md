# Run from source

## Prerequisites

- Node.js 22 or newer (the database library, better-sqlite3 13, needs it)
- npm
- Docker, for the machine history in development (optional)

## Folders

| Folder | What it holds |
| --- | --- |
| `apps/server` | The server and the API (Hono, Node.js) |
| `apps/web` | The web app (React, Vite) |
| `packages/shared` | The types and rules that the server and the web app share |
| `tools/fake-machines` | Fake CNC machines for tests (see [Fake machines](./fake-machines.md)) |
| `tools/fake-notify` | A fake Twilio and webhook receiver for the notifications (see [Fake notifications](./fake-machines.md#fake-notifications)) |
| `tools/quality` | Scripts that print the coverage reports as tables (see [Coverage](#coverage)) |
| `tools/loc` | `npm run loc`: the lines of code, tests and docs that the commits of a branch add and remove (see [Testing](#testing)) |
| `tools/guardrails` | Tests that keep the rules in `AGENTS.md`: no FANUC files, the volume names, the closed ports, and the docs links of the app |
| `tools/pi-image` | The Raspberry Pi card image (see [Pi card image](./pi-image.md)) |
| `tools/release` | The scripts that make the release files |
| `docs` | These docs |

## Run in development mode

```bash
npm install
npm run dev:history   # VictoriaMetrics and vmalert in Docker, on localhost only
npm run dev
```

This starts:
- **VictoriaMetrics** on http://localhost:8428 and **vmalert** (`docker-compose.dev.yml`). Stop them with `docker compose -f docker-compose.dev.yml down`. Without them, Chatter still runs, but it cannot save or show the machine history.
- **Server** on http://localhost:3001
- **Web app** on http://localhost:3000 (it sends `/api` on to the server)

vmalert sends its alerts to the server on port 3002. The server tells vmalert to read the alert rules again on http://localhost:8880.
`npm run dev:history` makes `apps/server/data/alert-rules/`. The server writes the alert rules there, and vmalert reads them from there.
If you start `docker-compose.dev.yml` yourself, run `mkdir -p apps/server/data/alert-rules` first. Else Docker can make the folder for the root user, and the server cannot write to it.
On Linux, set `ALERT_HOST=0.0.0.0` in `apps/server/.env`, because Docker cannot reach `127.0.0.1` of the computer. Then use a firewall rule, so that other computers cannot reach port 3002 (it has no login).

To test without real machines, run the fake machines in another terminal: `npm run fake-machines` (see [Fake machines](./fake-machines.md)).

::: warning A dev server takes the connection of a real machine
A Brother control serves only one connection. If your dev server polls a real machine of the shop, it takes that connection, and the Chatter of the shop shows the machine as offline.
Use the fake machines, or a copy of the database with no real machines. Stop the dev server when you are done.
**Find machines** in the Chatter of the shop shows each other Chatter on the network (see [Diagnostics](../guide/diagnostics.md#another-chatter-on-the-network)).
:::
To test Chatter on a Pi with the fake machines, use `npm run fake-machines -- --lan`. Then the Pi can find them on your local network. Their FTP servers take any password, so read [On the local network](./fake-machines.md#on-the-local-network) first.

For FANUC machines, see [FANUC machines](../guide/fanuc.md).

## Build the Docker image yourself

To run your own code changes in Docker, build the image in your copy of this repo:
```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Server settings

The server reads these environment variables. Each one is optional.
To keep them, copy `apps/server/.env.example` to `apps/server/.env`.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3001` | The port of the server and the API |
| `DATABASE_PATH` | `data/chatter.db` | The SQLite database. The path starts in the folder where the server runs (`apps/server` with `npm run dev`). |
| `WEB_DIR` | not set | The built web app. When it is set, the server also serves the web app. |
| `VICTORIA_METRICS_URL` | `http://localhost:8428` | Where the server saves the machine history |
| `ALERT_PORT` | `3002` | The port that gets the alerts from vmalert |
| `ALERT_HOST` | `127.0.0.1` | The address of the alert port (see [Security](../security.md)) |
| `ALERT_RULES_DIR` | `data/alert-rules` (next to the database) | The folder where the server writes the vmalert rules file. vmalert must read the same folder. |
| `VMALERT_URL` | `http://localhost:8880` | Where the server tells vmalert to read the rules again |
| `TRUST_PROXY` | not set | The reverse proxy addresses to trust (see [HTTPS and proxy](../guide/https.md)) |
| `LOG_FILE` | on | `off` keeps the log only in memory and in the console, not in `logs/chatter.log` next to the database (see [Diagnostics](../guide/diagnostics.md#server-log)) |
| `TWILIO_API_URL` | `https://api.twilio.com` | For development only: the address of a fake Twilio (see [Fake notifications](./fake-machines.md#fake-notifications)). Chatter sends the auth token there, so it takes only `https://`, or `http://` on this computer (`127.0.0.1`, `localhost`) |

The Docker image sets `CHATTER_VERSION`, the version that the app shows.
Two more variables are for the updates, and you do not usually set them:
`CHATTER_UPDATE_FOLDER` (the folder that the Pi card mounts, when it is not set) and
`CHATTER_RELEASES_REPO` (the GitHub repo to check for releases, for a fork; it must look like `owner/repo`, or Chatter does not start).
You do not need them with `npm run dev`.

## Testing

```bash
npm test                # all tests: web app, server, and fake machines
npm run test:client     # web app tests only
npm run test:server     # server tests only
npm run test:tools      # tests of the tools folder only
npm run typecheck       # check the TypeScript types in all parts
npm run lint            # check the code with ESLint
npm run dup:new         # find code that your branch copied
npm run dead            # find files, exports and packages that nothing uses
```

Some tests of the history backup need a real VictoriaMetrics and vmalert. Without them, these tests do not run. The CI runs them. To run them on your computer (Docker must run):

```bash
tools/victoria-test/start.sh
CHATTER_TEST_VICTORIA_URL=http://127.0.0.1:18429 npm run test:run -w apps/server -- src/history-backup src/routes/historyBackup
tools/victoria-test/stop.sh
```

To run all the checks for your branch and see one table, run `npm run quality`. Add `-- --coverage` to also list the changed lines that no test runs, or `-- --all` for the whole repo.
The full output of each check is in `.quality/`. The AI review skills `/chatter-review-code` and `/chatter-review-testing` use the same table.

To see the size of your change, run `npm run loc`. It prints the lines that the commits of your branch add and remove, in four parts: application code, tests, docs and comments, and files that it does not count (such as `package-lock.json` and binary files).
It counts commits only, not the changes that you did not commit. Add `-- --files` for one row for each file. `npm run quality` prints the same table, and the CI shows it in the summary of the test job of each pull request.
The size is a signal, not a gate. The rules for each part are in `tools/loc/README.md`.

### Lint

`npm run lint` checks all the code with ESLint. The config is `eslint.config.mjs`.

- An error fails the CI. Errors are likely bugs, or rules of this project. For example, the server logs with `createLogger`, not `console`, and web text uses `text-primary-text`, not `text-primary`.
- A warning does not fail the CI. Warnings are signals, such as a function that is too complex. Look at them when you change that code.
- To turn off a rule for one line, add `// eslint-disable-next-line <rule>` with a comment that tells why.

### Copied code

`npm run dup` finds blocks of code (70 tokens or more) that are in two places. The config is `.jscpd.json`. It does not check the tests.
`npm run dup:new` shows only the copies that your branch adds, compared with `origin/main`.

The CI fails when a pull request adds a copy. Move the shared code into one function, and call it from both places.
Copies that are already on `main` do not fail.

### Unused code

`npm run dead` runs knip. It finds files, exports and packages that nothing uses. The config is `knip.json`.

The CI shows the result in the job summary, but it does not fail. Do not add new unused code.
If you remove the last user of an export or a package, remove the export or the package too.

### Coverage

```bash
npm run coverage            # all tests in one run, with coverage
npm run coverage:summary    # the coverage of each workspace and tool, as a table
npm run coverage:changed    # the changed lines of your branch that no test runs
```

`npm run coverage` writes its reports to `coverage/`. Open `coverage/lcov-report/index.html` to see each line.
`coverage:changed` compares your branch with `origin/main`. To use a different base, add `-- --base <branch>`.
It also counts the files that you did not add to git yet.

Coverage is a signal, not a gate. A low number does not fail the CI.
Use it to find code that has no test, then write the test.
The CI shows both tables in the summary of the test job, and keeps the reports for 14 days.

The CI on GitHub also runs `npm audit` on `package-lock.json` and on `docs/package-lock.json`.
The check fails when a package has a known high or critical vulnerability.
For `docs/`, the check skips the dev dependencies that only build the site.
To do the same check on your computer, run `npm audit --audit-level=high` and `npm audit --prefix docs --omit=dev --audit-level=high`.

## Production build

```bash
# macOS and Linux
npm run build
WEB_DIR=../web/dist npm run start -w apps/server
```

This builds the shared package, the web app (`apps/web/dist/`), and the server (`apps/server/dist/`).
With `WEB_DIR` set, the server also serves the web app. The Docker image does this for you.

To make a new Admin outside Docker: `npm run reset-password -w apps/server` (or `reset-password:dev` without a build).
The command asks for the username and the password on the terminal, and removes the old Admin accounts.
It needs a terminal, so it does not read the password from a pipe.
The users who are not Admins stay. The first-run setup stays closed.
The command adds its log line to `logs/chatter.log` only when the file exists. It never makes the file, so a run with `sudo` cannot make a root file that the server cannot write.

## Work on these docs

The docs are in `docs/`. They are Markdown files, and [VitePress](https://vitepress.dev/) makes them into a website.
The docs have their own packages. Install them one time, then start the site on your computer:

```bash
npm install --prefix docs
npm run docs:dev
```

Then open the address that it prints. The menu on the left is in `docs/.vitepress/config.mts`. When you add a page, add it there too.
`npm run docs:build` makes the site, and stops on a link to a page that does not exist.
When a change to `docs/` goes into `main`, GitHub puts the new site on GitHub Pages (`.github/workflows/docs.yml`).
