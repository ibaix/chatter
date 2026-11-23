# Size of a change

`npm run loc` tells how many lines the commits of a branch add and remove, in four parts.

```bash
npm run loc                                      # this branch, compared with origin/main
npm run loc -- --base main                       # compare with a different base
npm run loc -- --base origin/main --head feat/x  # a branch that is not checked out
npm run loc -- --files                           # also one row for each file
npm run loc -- --json                            # the counts as JSON
```

The tool compares the head with the merge base of the base and the head, as a pull request does.
It counts commits only. It does not count changes that are not committed, and it writes a note on stderr when there are some.
It is a report. It never fails on a size.

## The parts

The first rule that matches a file wins.

| Part | What it holds |
| --- | --- |
| Not counted | Binary files, `package-lock.json`, `dist/`, `coverage/`, `docs/.vitepress/cache/`, SVG files, and each file that `.gitattributes` marks `linguist-generated` |
| Tests | `*.test.ts`, `*.test.tsx`, `*.test.sh`, each file in a `test/` folder, `testSupport.ts`, and the vitest `setupFiles`. The comments in these files are tests too. |
| Docs and comments | Each file in `docs/`, each `.md` file, and the comment lines of a source file |
| Application code | Each other line of a source file, also blank lines |

The sum of the four parts is always the sum of `git diff --numstat`.

## Comment lines

A line is a comment line when each character on it that is not white space is inside a comment.
A line with code and a comment at its end is a code line.

| Files | Comments |
| --- | --- |
| `.ts`, `.tsx`, `.js`, `.mjs`, `.mts` | The TypeScript parser finds them, so `//` in a string, a template, a regex or JSX text is not a comment. `{/* note */}` alone on a line is a comment line. |
| `.sh`, `.yml`, `Dockerfile`, systemd units, `.gitignore`, `.dockerignore`, `.env.example` | A line that starts with `#`. A `#!` on line 1 is code. |
| `.css` | `/* */`, but not in a quoted string |
| `.html`, `.vue` | `<!-- -->` |
| JSON and other files | No comments. Each line is code. Use `--files` to see these files. |

For an added line, the tool reads the file in the head. For a removed line, it reads the file in the merge base.

**Known limit:** for `#` comments, the tool reads each line by itself. A line that starts with `#` inside a heredoc or a multi-line string counts as a comment.
