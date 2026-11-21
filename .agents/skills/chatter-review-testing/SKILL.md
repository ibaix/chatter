---
name: chatter-review-testing
description: Reviews the tests of a Chatter change (the branch compared with main) - the coverage of the changed lines, test first, weak assertions, tests that only copy the code, and edge cases that no test covers. Use when the user says "review the tests", "/chatter-review-testing", "are the tests good enough?", or before a pull request. With the argument "all", it audits the whole test suite and the CI gates.
context: fork
---

# Review the tests of a change

Find out what the tests really check. A high coverage number does not tell you that. **Report only. Do not write tests.**

For bugs in the code itself, use `/chatter-review-code`.

## Scope

- **No argument:** the changes of this branch, compared with `origin/main`. This includes changes that are not committed, and new files.
- **`--base <ref>`:** compare with a different base, for example the branch below this one in a stack.
- **`all`:** the whole suite and the CI gates. Then do the [whole suite](#the-whole-suite-all) steps.

If `git merge-base origin/main HEAD` fails, run `git fetch origin` first.

## 1. Collect the evidence

1. Run the checks with coverage:
   ```bash
   npm run quality -- --coverage            # add: --base <ref>
   ```
   `✗ tests` is a Blocker. The changed lines that no test runs are in `.quality/coverage-changed.log`. The coverage of each workspace is in `.quality/coverage-summary.log`.
2. Make a list of the changed source files, and of the test file for each one (`x.ts` and `x.test.ts`, in the same folder).
3. Read each changed test. Read what it asserts, not only its name.

Put each `⊘` in the report with its reason.

## 2. Pass 1: write down each problem

**Behavior with no test.**
- A changed line that holds logic and that no test runs. Lines that are only types, imports or JSX layout do not count.
- A changed source file with no test file, when it holds logic.
- A bug fix with no test that fails without the fix.

**Test first.** CONTRIBUTING asks for the test first. For each changed source file, run:
```bash
git log --reverse --format='%h %s' $(git merge-base origin/main HEAD)..HEAD -- <file> <its test file>
```
The test must come in the same commit as the code, or before it. If the history was squashed, write "cannot tell". This is a note, not a Blocker.

**Tests that only copy the code.** When the same agent writes the code and the test, the test often checks what the code does, not what the user wanted. Then the test keeps the bug. Signs:
- An expected value that is a number from a run, with nothing that says why (`expect(total).toBe(107.53)`).
- One test for each branch of the code, also for branches that cannot happen.
- A mock that gives exactly what the code asks for, so the test checks the mock.

The check: write the requirement in one sentence **without** reading the code. Then ask: does the test fail if the code breaks this requirement? If you cannot write the requirement, that is the finding.

**Weak assertions.** Search the changed tests:
```bash
git diff $(git merge-base origin/main HEAD) -- '*.test.ts' '*.test.tsx' | grep -nE '^\+.*(\.only\(|\.skip\(|toBeDefined\(\)|toBeTruthy\(\)|not\.toBeNull\(\)|toHaveBeenCalled\(\))'
```
- `.only` or `.skip` in a committed test is a Blocker.
- `toBeDefined()`, `toBeTruthy()`, `not.toBeNull()` or `toHaveBeenCalled()` with no check of the value or the arguments passes when the code is wrong.

**Rules of this project.**
- **Logs.** A server test that checks a log line uses `captureLog()` from `apps/server/src/logging/testSupport.ts`. It does not spy on `console`.
- **Machines.** A connector or protocol change has a test against the fake machines in `tools/fake-machines`, or against the real protocol format. A hand-written mock of a socket that answers what the code expects does not count. A notification channel tests its HTTP calls with `fakeFetch` of `apps/server/src/notifications/channels/testSupport.ts`, so no test sends a real message.
- **Time.** Code that uses timers, polling or dates uses fake timers (`vi.useFakeTimers()`) and a fixed time zone. A test that waits for real time is slow and flaky.
- **Watch mode.** A command in a doc or a skill that runs the tests of a workspace uses `test:run`, not `test`. `test` starts vitest in watch mode, and it does not stop.
- **Shared types.** A new rule in `packages/shared` has its test in `packages/shared`, not only in the web app or the server.

**Edge cases.** For each changed function, list the cases that no test covers:
- 0, 1 and many items.
- A machine that is offline, that is slow (timeout), or that drops the connection and comes back.
- A time zone or day boundary, and a change of summer time.
- Input that is not valid at the API edge (the `zod` schema).
- Save and load, or encode and decode, as a round trip.

## 3. Pass 2: decide

- **Blocker.** `✗ tests`, a committed `.only` or `.skip`, or a changed behavior with no test at all.
- **Should fix.** A changed line with logic and no test, a weak assertion, a test that only copies the code, a missing edge case that can happen in a shop, or a broken project rule.
- **Note.** Test first not clear from the history, a small missing edge, or a test name that does not say the requirement.

Coverage is a signal, not a gate. Do not ask for a test only to make the number go up. Framework start-up code, pure layout and guards that cannot happen do not need tests. Say so in one line.

## 4. Report

1. **Checks:** the table of `npm run quality -- --coverage`.
2. **Changed lines with no test:** the table from `.quality/coverage-changed.log`, only the rows with lines that hold logic.
3. **Findings**, Blocker first. For each: the file, the problem, and **the test to write**, for example "in `FTPClient.test.ts`, assert that `list()` keeps the first error as `cause` when the server closes the connection".
4. **Signals:** the coverage of each workspace from `.quality/coverage-summary.log`. Say plainly that these are not tasks.

If the tests are good, say so in one sentence. Do not look for problems to fill the report.

## The whole suite (`all`)

1. **The gates first.** Read `.github/workflows/*.yml`. Make a short table: which command runs on a pull request, on a push to `main`, and at a release. Then check:
   - Each test folder runs in a gate: the workspaces through `npm test`, and each `tools/*` folder through `test:tools`. A test file that no gate runs is a finding.
   - No gate can pass when it should fail: look for `continue-on-error: true`, `|| true`, `exit 0`, a `paths:` filter that skips tests, and a test file that runs 0 tests.
   - Coverage and unused code are only reports on purpose. That is not a finding.
2. Run `npm run quality -- --all --coverage`.
3. Do Pass 1 over the whole suite. Start with the files that have the most logic and the lowest coverage.
4. Give a plan in three groups: **Do first** (gaps in the gates, then tests for logic that has none, then weak assertions), **Do second** (round trips, edge cases, tests against the fake machines), **Skip for now** (with one line on why). Each item has the file, the behavior to test, and the kind of test.
5. End with a **Signals** block: the coverage of each workspace.
