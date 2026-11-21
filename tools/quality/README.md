# Quality reports

Scripts that read the reports of the code checks and print them as Markdown tables.

```bash
npm run coverage            # make the coverage reports in coverage/
npm run coverage:summary    # coverage of each workspace and tool
npm run coverage:changed    # changed lines of this branch that no test runs
```

These scripts never fail on a low number. For more, see [docs/develop/index.md](../../docs/develop/index.md#coverage).
