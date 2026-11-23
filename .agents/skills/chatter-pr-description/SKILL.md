---
name: chatter-pr-description
description: Writes or updates the pull request description of a Chatter branch - summary, what changed and why, tests, docs, risks and follow-ups, the line-count table of `npm run loc`, and the stack and base note. Use when the user says "write the PR description", "/chatter-pr-description", "open a PR", or after a fix adds commits to an open PR ("update the PR body").
---

# Write the pull request description

Write a description that a reviewer can trust. Each sentence comes from evidence: the commits, the diff, the plan, or a check that someone ran.

## Inputs

- **No argument:** the current branch. The base is the `baseRefName` of its open pull request, else `origin/main`.
- **`--base <ref>`:** a different base, for example the branch below this one in a stack.
- **`--plan <file>[#item]`:** the plan item that this change does. Read it for the "why" and for the follow-ups.
- **`--pr <n>`:** the pull request to update.
- **`update`:** update the body of an open pull request. Then do [Update mode](#update-mode).

Find the open pull request of the branch with `gh pr view --json number,baseRefName,headRefOid,body`. If there is none, the base is `origin/main`.

## 1. Collect the evidence

Set `M=$(git merge-base <base> HEAD)`. If this fails, run `git fetch origin` first.

1. The commits: `git log --format='%s%n%b' $M..HEAD`.
2. The files: `git diff --stat $M`.
3. The diff: `git diff $M`. Read each new file.
4. The size: `npm run -s loc -- --base <base>`. Copy its output as it is. Do not change a number.
5. The plan item, if there is a `--plan`.
6. The logs in `.quality/`, if they are there. They tell which checks ran and what they found.

**Do not run the tests again.** List only the checks that have evidence: a log, a CI run, or a result in this conversation. Say who ran each check (you, the CI, or the user). If a check has no evidence, do not say that it passed.

## 2. Write the body

Use ASD-STE100 Simplified Technical English: short sentences, active voice, one idea in each sentence. Use this template:

```markdown
## Summary

<One to three sentences: what the change does for the user, and why.>

## Stack

Base: `<base>`. <"Targets main." or "Merge after #N.">

## What changed and why

**Server**
- <A change and its reason, in one line.>

**Web** / **Shared** / **Tools** / **CI** / **Docs**
- <Only the areas that the change touches.>

## Tests

- <A test file: the behavior that it proves.>
- Checks: <each check with evidence, and who ran it. For example: "npm test passed (ran locally)", "CI: green".>
- <"Tested on a real <machine>." or "Not tested on a real machine.">

## Docs

- <Each changed page and what it now tells. Or: "No docs change.", with the reason.>

## Risks and follow-ups

- <A risk, a data migration, or an AGENTS.md guardrail that the change touches (kept or changed).>
- <A follow-up, with its plan item.>

## Size

<!-- loc:start base=<merge base sha> head=<head sha> -->
<output of npm run -s loc -- --base <base>>
<!-- loc:end -->
```

The rules:

- Leave out a section only when it has nothing true to say. Keep `## Size` always.
- Group the bullets in "What changed and why" by area. One line for each change. One line for each fix.
- In "Risks and follow-ups", check the guardrails in `AGENTS.md`. Name each one that the diff touches.
- Use the full shas of `git merge-base <base> HEAD` and `git rev-parse HEAD` in the `loc:start` marker.
- **Do not add a "Generated with" line. Do not add a `Co-Authored-By` line.** CONTRIBUTING.md forbids AI attribution in a pull request.

## 3. Give the body

1. Write the body to a scratch file. Never pass the body on the command line.
2. If the user asked you to open or edit the pull request:
   - New: `gh pr create --base <base branch> --title "<prefix>: <subject>" --body-file <file>`. Use a title with a commit prefix, such as `feat(web):` or `fix(server):`.
   - Open: `gh pr edit <n> --body-file <file>`.
3. Else print the body, and tell the user the path of the file.

## Update mode

Use it after a review fix adds commits to an open pull request.

1. Read the pull request: `gh pr view <n> --json body,baseRefName,headRefOid`.
2. Read the old head from the marker `<!-- loc:start base=... head=<old head> -->`. If there is no marker, use the `headRefOid` from before the new push, or ask the user.
3. Run `npm run -s loc -- --base <base>` again. Replace only the text between `<!-- loc:start ... -->` and `<!-- loc:end -->`, and put the new shas in the marker.
4. Add a section `## Changes after review`, or add to it. Write one line for each commit subject in `git log --format=%s <old head>..HEAD`.
5. Keep the sections that a person wrote. Change a sentence only when a new commit makes it wrong. Then say in "Changes after review" which sentence you changed.
6. If the base changed (the branch below merged, or the pull request has a new base), write the Stack section again.
7. Write the body to a scratch file, then run `gh pr edit <n> --body-file <file>`.
