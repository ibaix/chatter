# Use HTTPS

Chatter serves plain HTTP. To use HTTPS, put a reverse proxy in front of it, for example Caddy or nginx.
A reverse proxy is a server that takes the HTTPS requests from the browsers, and sends them on to Chatter.

## Set up the proxy

1. Set up the proxy to send the requests to Chatter on port 3001, with the `X-Forwarded-For` and `X-Forwarded-Proto` headers.
   Caddy sends these headers by itself. For nginx, add:
   ```nginx
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   ```
2. Open Chatter through the proxy, and log in as an Admin. Go to **Settings > HTTPS and proxy**.
   The proxy is in the list **Computers that sent proxy headers**. Click **Trust** on its line.
   You can also type its address in **Add a proxy address or range**.
   Do not trust a wide range, like `172.16.0.0/12`, if normal users also have addresses in it.
3. Reload the page. At the bottom, **This page came** shows **Over HTTPS**, and **Through the proxy** shows the address of the proxy.
4. Let only the proxy reach port 3001. This step is part of the security: a computer that reaches port 3001 directly, from a trusted address, can send a false user address.
   - **The proxy runs directly on the same computer, not in Docker.** Change `"3001:3001"` to `"127.0.0.1:3001:3001"`, then run `docker compose up -d`. Do this change again after each update, because an update replaces `docker-compose.yml`.
   - **The proxy runs in a Docker container on the same computer.** Do not use `127.0.0.1:3001:3001`. This proxy connects through the gateway of the Docker network (the `TRUST_PROXY: "172.18.0.1"` example in `docker-compose.yml`), so it cannot reach `127.0.0.1` of the computer. Use a rule in the `DOCKER-USER` chain, and leave out `! -s <proxy address>`. The rule then stops each computer on the network. The proxy container can still reach Chatter, because its traffic does not come in on the network interface.
   - **The proxy runs on a different computer.** Use a rule in the `DOCKER-USER` chain. Put the address of the proxy after `! -s`, not the address of your network:
     ```bash
     sudo iptables -I DOCKER-USER -i <LAN interface> -p tcp -m conntrack --ctorigdstport 3001 --ctdir ORIGINAL ! -s <proxy address> -j DROP
     ```

   A ufw or firewalld rule does not limit a port that Docker publishes. For `<LAN interface>`, and to keep the rule after a restart, see [Limit who can reach Chatter](../security.md#limit-who-can-reach-chatter).

Chatter believes the `X-Forwarded-*` headers only from the trusted addresses, because any computer can send them.
Only one proxy in front of Chatter is supported.

A browser that logged in over plain HTTP before the move keeps that login. The login ends when the browser is not used for 14 days, and 1 year after the log in at the latest.

## Security headers from the proxy

Chatter sends its own security headers on each reply. It does not send HSTS (`Strict-Transport-Security`), because HSTS on a LAN address can stop the access to Chatter.
When all users open Chatter through the proxy, you can set the proxy to add HSTS.

Do not set the proxy to add a second `Content-Security-Policy` or `X-Frame-Options` header.
Chatter already sends them. If the proxy adds a second Content-Security-Policy, the browser obeys the two policies together, and the page can stop working.

## Set the trusted addresses in a file

You can also set the trusted addresses with the `TRUST_PROXY` environment variable, for example in `docker-compose.yml` (see the example in the file). Then run `docker compose up -d`.
Put commas between more than one address or range. A wrong value stops Chatter at the start, and the log tells which entry is wrong.
When `TRUST_PROXY` is set, it always wins, and you cannot change the list in Settings.
Without Docker, set it before the start: `TRUST_PROXY=127.0.0.1 npm run start -w apps/server`.
