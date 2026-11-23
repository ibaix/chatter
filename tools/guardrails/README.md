# Guardrail tests

Tests that keep the guardrails in [AGENTS.md](../../AGENTS.md#guardrails):

- No FANUC FOCAS2 files are in git.
- `docker-compose.yml` keeps the volume names, and the folder name `chatter` stays in the Docker package and on the Pi card.
- `docker-compose.yml` and `docker-compose.dev.yml` keep the deduplication of VictoriaMetrics, so a second history restore does not double the samples.
- `docker-compose.yml` keeps the facts that the docs quote: the container name `chatterbox` (for `docker logs chatterbox`) and the port entry `"3001:3001"` of Chatter (the HTTPS page tells users to change it). To change one, change the docs in the same change.
- No compose file opens VictoriaMetrics, vmalert or the alert port 3002 to the network.
- The update helper on the Pi (`STEPS` in `update-chatter.sh`) and Chatter (`UPDATE_STEPS` in `packages/shared`) have the same steps, in the same order.
- Each docs link in the app goes to a page and a heading that exist. The links of released apps (`guide/update#back-up` and `guide/manage`) always stay.
- Each link in the docs to a heading (`./page.md#heading` or `#heading`) goes to a heading that exists, with the anchor that VitePress makes (or a `{#id}`). `npm run docs:build` does not check these links.
- Each workflow gives only read permissions at the top. A job that must write gets its permissions in its own block. Only the jobs in the allow-list of the test can write, and each one gets exactly the write scopes of its entry. No job gets `write-all`. To give a job write permissions, add it to the allow-list in the same change.
- Each job that writes in the Pi card, the image cleanup and the moving image tags runs only from main or a release tag.
- Each workflow pins each action by a full commit, with the version in a comment. A local action (`./`) is not pinned.
- Only the sign job in `docker.yml` gets the update signing key and the `release` environment. It runs after the publish job, runs no action except the checkout, and gets only `contents: write` and `packages: read`. No job gets all the secrets (`secrets: inherit` or `toJSON(secrets)`), and no workflow reads a secret by a computed name (`secrets[...]`).
- The publish job and the sign job run `tools/release/check-tag-on-main.sh` before they publish or sign. The script stops the job when the tag is not on main.
- A workflow step runs each shell test of the Pi card (`tools/pi-image/test/*.test.sh`) and of the release scripts (`tools/release/test/*.test.sh`). `npm test` does not run them.
- The built web app (`apps/web/dist`) obeys the Content-Security-Policy of the server: no script in the page, no event attribute (such as `onload`), no `eval(` or `new Function(` in the scripts, and no `@import` or `url()` to another site in the styles. The CI `build` job runs `npm run check:web-dist` after `npm run build`. `npm test` runs only the tests of this check.

`npm test` runs them (through `npm run test:tools`). If one fails, fix the change, not the test.
