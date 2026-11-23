# Changelog

Versions are `<HA add-on version>-<Podman revision>`: the HA add-on image the edition runs, and
the revision of this repo's packaging on it.

## 0.1.7-rc.14-1 (unreleased)

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
