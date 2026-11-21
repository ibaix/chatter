# Guardrail tests

Tests that keep the guardrails in [AGENTS.md](../../AGENTS.md#guardrails):

- No FANUC FOCAS2 files are in git.
- `docker-compose.yml` keeps the volume names, and the folder name `chatter` stays in the Docker package and on the Pi card.
- `docker-compose.yml` and `docker-compose.dev.yml` keep the deduplication of VictoriaMetrics, so a second history restore does not double the samples.
- No compose file opens VictoriaMetrics, vmalert or the alert port 3002 to the network.
- The update helper on the Pi (`STEPS` in `update-chatter.sh`) and Chatter (`UPDATE_STEPS` in `packages/shared`) have the same steps, in the same order.
- Each docs link in the app goes to a page and a heading that exist. The links of released apps (`guide/update#back-up` and `guide/manage`) always stay.
- A workflow runs each shell test of the Pi card (`tools/pi-image/test/*.test.sh`). `npm test` does not run them.

`npm test` runs them (through `npm run test:tools`). If one fails, fix the change, not the test.
