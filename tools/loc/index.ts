// Prints the size of a change as a Markdown table: application code, tests, docs and comments, and not counted.
//
//   npm run loc                                     the commits of this branch, compared with origin/main
//   npm run loc -- --base main                      compare with a different base
//   npm run loc -- --base origin/main --head feat/x  a branch that is not checked out
//   npm run loc -- --files                          also one row for each file
//   npm run loc -- --json                           the counts as JSON
//
// It counts commits only, not the changes that are not committed. It is a report: it never fails on a size.
import { runLoc } from './loc';

const { stdout, stderr, exitCode } = runLoc(process.argv.slice(2), process.cwd());
process.stderr.write(stderr);
process.stdout.write(stdout);
process.exitCode = exitCode;
