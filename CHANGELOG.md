# Changelog

Versions are `<HA add-on version>-<Podman revision>`: the HA add-on image the edition runs, and
the revision of this repo's packaging on it.

## 0.1.7-rc.14-5 (unreleased)

- The web app has the woowtech bot icons of the PaaS edition instead of the MausBot ones of the HA
  image: the browser tab, the About dialog, the settings, and the icon and opening screen of the app
  added to a phone's home screen. `image/brand` holds the four files, byte for byte the ones PaaS
  serves. `brand.cjs` checks them at build time, gives iPhone home screens the name woowtechbot and
  asks for the icons with `?v=<hash>`, so Cloudflare and browsers do not keep showing a cached MausBot
  icon. The build stops when a new base changes the lines it edits.
- README: the phone App (MausBot, from the app stores) keeps its own icon and opening screen, which
  cannot be changed here; how to put the web app on a phone's home screen instead, as PaaS advises.
- Tests: `tests/brand.test.cjs`. `tests/smoke.sh` and `scripts/check-public.sh` check that the icons
  arrive, the latter through Cloudflare.
- 0.1.7-rc.14-4 was a test build that was withdrawn; the number is not used again.

## 0.1.7-rc.14-3 (unreleased)

- Cockpit page (`cockpit/`, `sudo scripts/cockpit-page.sh install`): the HA add-on's administrator
  page in Cockpit's Tools, for the members of the administrator group with administrative access on.
  Browser and phone pairing (QR code, server address, code, countdown, copy, cancel), the bot's status
  (container, versions, addresses, AI connections, first administrator and email sign-in settings)
  and the signed-in devices, with sign-out. A root helper runs podman as the bot's account and
  `pair.cjs` inside the container, never restarts or changes the bot, gives each administrator codes
  of their own and logs every change (`journalctl -t woowtech-cockpit-woowtechbot`) without the code.
  Non-administrators get neither the page nor its files.
- `scripts/pair.sh devices` and `signout DEVICE`. `pair.cjs state` (the page's view, never a code) and
  `--by ACCOUNT` (an administrator's own codes).
- A new code that cannot be shown (the QR code cannot be drawn) is cancelled instead of left usable.
- The browser pairing text says to press 「連線」.
- Tests: `tests/test_cockpit_helper.py` (the helper with a fake podman, the real `pair.cjs` and a
  stand-in app), `tests/page.test.cjs` (static checks of the page), and `tests/cockpit-lab.sh` with
  `tests/cockpit-page.cjs`: the page in a real Cockpit 362 with sudo and rootless Podman, in a
  throwaway container, driven by Playwright.

## 0.1.7-rc.14-2 (unreleased)

- Optional Cloudflare Tunnel connectors of the bot's own (`quadlet/optional`): `woowtechbot-tunnel`
  (bot address, and the published site when both are routes of one tunnel) and
  `woowtechbot-apps-tunnel` (the published site on a tunnel of its own). Installed only while their
  token secret is set (`scripts/secret.sh set tunnel-token` / `apps-tunnel-token`) and removed when it
  is cleared. They join the bot's private network, publish nothing on the host, and the token never
  reaches the bot's container. A bad token is reported and leaves the bot running.
- `scripts/check-public.sh`: checks the public addresses from the outside (TLS, no Access login in
  front of the bot, the login boundary and no-store, no pairing codes from outside, the published
  site's isolation); `--pairing` also signs in once with a one-time code over the public address.
- `WTB_SERVER_NAME`: the label of this server in the apps, as `bot.serverName` on PaaS. Without it the
  label is the container's host name, `woowtechbot`, the same as a PaaS service's default.
- `install.sh --dry-run --set` no longer reports a setting as set. Its settings check now sees the `--set`
  values. README: put the sign-in relay token in first, then set the relay URL (the other way round is
  refused half-way); who may sign in with an emailed code.
- `tests/ha-suites.sh`: runs the HA add-on's own suites from a checkout of the matching release
  (tools, published apps in both modes before and after a restart, the email sign-in flow against a
  mail stand-in). `tests/public.sh`: check-public.sh against a TLS stand-in for the tunnel, and
  against a broken set-up that it must reject.

## 0.1.7-rc.14-1 (2026-11-24)

- First Podman edition: the HA add-on image `ghcr.io/woowtech/amd64-woowtechbot:0.1.7-rc.14`,
  pinned by digest, plus an entry point that does what the HA Supervisor does there: it builds
  `/data/options.json` from `~/.config/woowtechbot/woowtechbot.env` and the optional podman
  secrets, checks them against the add-on's `config.yaml` schema and with the add-on's own
  validators (exit 78 and the setting's name on a bad value), and then runs the add-on unchanged.
- Credentials never reach the data volume or the bots: the options live on a private tmpfs
  (`/data/options.json` is a link to it), the podman secrets are mounted root-only, and the add-on
  and the bots it runs get no `WTB_*` variables.
- `scripts/pair.sh` gives the host administrator the HA administrator page's pairing codes: browser
  code and link, phone QR (drawn in the terminal), server address and code, list and cancel. Codes
  last 10 minutes, work once, and a new code replaces this tool's unused code of that kind.
- Rootless Quadlet unit on a private network, only the entrance published (127.0.0.1:18799 by
  default) and the published-apps site when `WTB_PUBLISHED_URL` is set; never 8099 or 8799, never
  host networking. Limits 4 GiB (no swap), 2 CPUs, 4096 pids, 3 turns at once; 512 MiB `/dev/shm`.
- `scripts/install.sh` (idempotent; `--gh-auth` pulls the private base with the gh token without
  writing it to disk), `scripts/uninstall.sh` (`--purge` keeps a final backup), `scripts/secret.sh`.
- Live checks on a host: `tests/smoke.sh` (24 checks: unit, ports, tmpfs options, root-only
  secrets, the app's processes, limits, the owner API not reachable through the entrance, one-time
  pairing, the code in no log) and `tests/runtime.sh` (the HA add-on's runtime verification on the
  Podman path in a throwaway container: Odoo MCP read-only gateways from root-only secret files,
  unpaired and forged-ingress requests refused, engine versions).
