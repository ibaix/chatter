---
name: chatter-review-code
description: Reviews the code of a Chatter change (the branch compared with main) for bugs, the AGENTS.md guardrails, lint errors, copied code and unused code. It uses the results of the code checks, not only judgement. Use when the user says "review the code", "/chatter-review-code", "is this ready for a pull request?", or before a pull request. With the argument "all", it reviews the structure of the whole repo and gives a refactor plan.
context: fork
---

# Review the code of a change

Find the problems in a change before a person reviews it. **Report only. Do not change the code.**

For the tests of the change, use `/chatter-review-testing`. This skill reads the tests only to find bugs in the code.

## Scope

- **No argument:** the changes of this branch, compared with `origin/main`. This includes changes that are not committed, and new files.
- **`--base <ref>`:** compare with a different base, for example the branch below this one in a stack.
- **`all`:** the whole repo. Then do the [whole repo](#the-whole-repo-all) steps.

If `git merge-base origin/main HEAD` fails, run `git fetch origin` first.

## 1. Collect the evidence

1. Run the checks:
   ```bash
   npm run quality                    # add: -- --base <ref>, or -- --all
   ```
   It prints one table. `✓` passed. `✗` is a gate that the CI also fails on. `!` is a signal. `⊘` is a check that did not run, with the reason. The full output of each check is in `.quality/<check>.log`.
2. Read the diff: `git diff $(git merge-base origin/main HEAD)`, and each new file.
3. Read the code around each change, not only the changed lines. A bug often sits in the caller.

Put each `⊘` in the report with its reason. Never leave out a check that did not run. A missing check looks like a clean result.

## 2. Pass 1: write down each problem

Write down each problem with its file, line and how sure you are. Do not sort them yet.

**From the checks:**
- `✗ typecheck`, `✗ lint` or `✗ tests`: the error, from the log.
- `✗ new-copied-code`: the copy in `.quality/new-copied-code.log`. Say which function both places should call.
- `! unused-code`: an export, file or package that nothing uses. Only a finding if this change added it, or removed its last user. Code that was already unused is a note.
- `! lint-warnings`: complexity and depth are signals, not findings (see Pass 2). `react-hooks/exhaustive-deps` in a changed hook is a finding if a missing dependency gives a stale value.

**From the guardrails in `AGENTS.md`.** The tests in `tools/guardrails` check some of them. Check the others by hand:
- **FANUC files.** No `Fwlib*` or `libfwlib32*` file in the diff. A change to a `Dockerfile` or a workflow must not put `apps/server/native/focas/` into an image that we publish.
- **Pi memory (512 MB).** An upload, a download or a file read must stream to disk, as `apps/server/src/updates/streamToFile.ts` does. Look for `arrayBuffer()`, `readFile`, `Buffer.concat` or `await response.text()` on a file or a body that can be large. Look also for a list or a cache that grows with no limit.
- **Update helper.** A change in `apps/server/src/updates/` or `tools/pi-image/` must keep the boundary: Chatter only writes a request file, and the helper trusts nothing from Chatter. Read [docs/security.md](../../../docs/security.md#updates-on-the-pi-card).
- **User data.** The `chatter` folder name and the volume names stay (a guardrail test checks this).
- **Closed ports.** VictoriaMetrics, vmalert and port 3002 stay unpublished (a guardrail test checks this).
- **Doc links.** `guide/update#back-up` and `guide/manage` stay (a guardrail test checks this).
- **Server logging.** Use `createLogger('component')`, not `console` (ESLint checks this). A log line must not hold a password, a token or a secret setting.
- **Web colors.** Text uses `text-primary-text`. Fills and borders use `primary` (ESLint checks this).
- **Simplified Technical English.** Changed docs, screen text and skills use short sentences, active voice, and one idea in each sentence. This needs judgement.
- **New machine type or notification channel.** Compare the change with the steps in `.agents/skills/add-machine-type/SKILL.md` or `.agents/skills/add-notification-channel/SKILL.md`. A missing step is a finding.

**From reading the code:**
- **Correctness.** Error paths, an `await` that is missing, races between two async calls, a timer or a socket that is not closed, off-by-one, time zones, units (mm and inch, ms and s).
- **The API edge.** Each new route checks its input with `zod`, and checks the role of the user (`packages/shared/src/roles.ts`).
- **Machine connections.** A connector must handle a machine that is off, slow, or that drops the connection. It must not stop the polling of the other machines.
- **Security.** Secrets in code, missing input checks, a path that comes from the user and is not checked. Put these at the top.
- **Types.** `any`, an `as` cast that hides a real type problem, or a public function with no types.

## 3. Pass 2: decide

Sort each problem into one group:

- **Blocker.** A `✗` gate, a broken guardrail, a security problem, or a bug that you can show with steps or input.
- **Should fix.** New copied code, new unused code, a missing `zod` check, a stale hook value, a problem in the change that a later change will find hard to fix.
- **Note.** Small things. Leave out format nits and ideas for the far future.

**Signals are not findings.** Complexity, depth, file length and the coverage percent are signals. A signal becomes a finding only when it points at a real problem in the list. "`FTPClient.ts` has a complexity of 14" is a signal. "`FTPClient.ts` mixes the FTP protocol and the error text of the screen" is a finding. Do not ask the user to split a function only to make a number go down.

## 4. Report

1. **Checks:** the table of `npm run quality`, with each `✗` and `⊘` explained in one line.
2. **Findings**, Blocker first. For each: `file:line`, the problem, the evidence (the tool and rule, or the input that breaks it), and the fix in one or two sentences.
3. **Guardrails:** one line for each guardrail that the change touches: kept, or broken.
4. **Signals:** lint warnings and unused code in the scope, as numbers. Say plainly that these are not tasks.
5. If the change has code with no test, say so in one line, and point to `/chatter-review-testing`.

If there is no Blocker and no Should fix, say so in one sentence. Do not look for problems to fill the report.

## The whole repo (`all`)

Use this to decide if the code needs a refactor. It is not a review of one change.

1. Run `npm run quality -- --all --coverage`.
2. Run `scripts/change-shape.sh` from this skill folder (`.agents/skills/chatter-review-code/scripts/`). It lists the recent feature and fix commits with the number of files and folders that each changed, and the files that change most often.
3. Read the commits that changed many folders. Name the shape:
   - **Shotgun change:** the same small edit in many files.
   - **Layer crossing:** each feature changes the server, the web app, the shared types and the docs. Chatter often needs this, so it is a finding only when the shared types do not carry the rule.
   - **Hot file:** one file in almost every change, for example a big page component.
4. Do Pass 1 and Pass 2 over the whole repo. Look also for logic inside React components or Hono routes that a plain function should hold, so that a unit test can reach it.
5. Give a plan in three groups: **Do first** (high value, low risk), **Do second**, **Skip for now** (with one line on why). Each item has the file, the problem and the change, for example "move lines 40–95 of `SettingsTab.tsx` into `settingsForm.ts`, and test it there". Code with no tests is not ready for a refactor: mark it "tests first".
6. End with a **Signals** block: lint warnings, copies, unused code and the coverage of each workspace.
