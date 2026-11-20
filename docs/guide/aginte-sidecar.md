# Aginte sidecar

Use this profile when Aginte runs Chatter as a headless protocol gateway.

Chatter listens on `127.0.0.1` port `3001` only. Aginte is the program that calls Chatter. Aginte keeps the data and shows the pages.

With these variables unset, Chatter starts the same way as the standard Compose file.

## Start the gateway

`docker-compose.aginte-sidecar.yml` starts the Chatter server alone. VictoriaMetrics stays off. vmalert stays off.

From the repository root, run:

```bash
docker compose -f docker-compose.aginte-sidecar.yml up -d --build
```

The container sets these variables:

| Variable | Value | Result |
| --- | --- | --- |
| `WEB_DIR` | empty | Chatter has no web files to serve |
| `CHATTER_DISABLE_WEB_UI` | `1` | Chatter serves no web pages |
| `CHATTER_DISABLE_HISTORY` | `1` | Chatter writes no machine-number history. The vmalert port stays closed |
| `CHATTER_DISABLE_UPDATE_CHECK` | `1` | Chatter sends no request to GitHub |

The published port is `127.0.0.1:3001:3001`. Other computers cannot open it.

`GET /` answers `404` with `{ "error": "Not found" }`. These paths stay available: `/api/health`, `/api/status`, `/api/machines`, and `/api/events`.

A history request such as `GET /api/machine/:id/history/:value` answers `503` when VictoriaMetrics is off. A login is still required. See [Login and settings](../api/auth-and-settings.md).

## Make a viewer account

Set the variables in the environment. Keep the passwords out of the command line.

- `CHATTER_URL` defaults to `http://127.0.0.1:3001`. The script accepts only a loopback address.
- `CHATTER_ADMIN_USERNAME` and `CHATTER_ADMIN_PASSWORD` are the Admin login. The password has at least 8 characters.
- `CHATTER_VIEWER_USERNAME` and `CHATTER_VIEWER_PASSWORD` are the reader login. The password has at least 8 characters. The role is `viewer`.

On the first start, the script makes the Admin account. Then it makes the viewer account. When that account already has role `viewer`, the script ends with success. When that username has another role, the script stops with an error. The script leaves that account unchanged.

Run:

```bash
node --experimental-strip-types tools/aginte-sidecar/bootstrap-viewer.ts
```

The script prints no password and no `Authorization` header.

## License

Chatter is MIT licensed. Copyright 2025-2026 Toolpath. Keep this copyright notice with every copy of Chatter. The `LICENSE` file in this repository contains the full terms.
