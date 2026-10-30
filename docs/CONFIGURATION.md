# Configuration reference

Crystal Bridge is configured with environment variables. A Kingdom reads `~/.config/crystal-bridge/crystal.env`, which
`join` and the deploy scripts write; a hub from the deploy script reads `/etc/crystal-bridge/airship.env`. Commented
examples are in [`deploy/crystal`](../deploy/crystal/crystal.env.example) and
[`deploy/airship`](../deploy/airship/airship.env.example).

A test (`scripts/config-reference.test.ts`) fails when the code uses a `CRYSTAL_` or `AIRSHIP_` variable this table
doesn't list. It checks names only, so check a default against the code when you change one.

| Variable | Default | Used by |
|---|---|---|
| `CRYSTAL_HUB` | `ws://127.0.0.1:7700/node` | Crystal: the hub's node WebSocket |
| `CRYSTAL_NODE` | `local` | Crystal: this machine's node id |
| `CRYSTAL_TOKEN` | unset | Crystal: its node token, sent as a bearer header and kept out of sessions' environment |
| `CRYSTAL_MCP_PORT` | `7701`; `join` and the macOS deploy write `7711` | Crystal: its local port (permission tool, hooks, status) |
| `CRYSTAL_IDLE_MS` | `600000` | Crystal: stop an idle session's process after this long; the next follow-up resumes it |
| `CRYSTAL_DEFAULT_MODE` | `manual`; `join` and the deploy scripts write `auto` | Crystal: permission mode for new sessions. An unknown value also means `manual`. So `pnpm dev` asks for every action, and a joined or deployed Kingdom asks only when the CLI is unsure |
| `CRYSTAL_PROJECT_ROOTS` | `~/code` | Crystal: where the New Quest picker looks for repos (`:`-separated) |
| `CRYSTAL_CHROME` | unset | Crystal: `1` starts sessions with `--chrome` |
| `CRYSTAL_ENGINES` | `stream` | Crystal: `stream,interactive` enables the interactive engine; `stream` is always on |
| `CRYSTAL_LOGIN_SHELL` | `$SHELL`, then `/bin/bash` | Crystal: the shell whose login environment sessions get; `join` writes it |
| `CRYSTAL_SESSION` | set by Crystal | Not a setting: the session id on each `claude` process, so a hook can tell it runs under the bridge |
| `CRYSTAL_DRAIN_SECONDS` | `600` | Crystal deploy scripts: how long to wait for running turns before giving up |
| `CLAUDE_BIN` | `claude` | Crystal: the CLI it runs |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Crystal: where the CLI keeps its session transcripts, for finding sessions |
| `AIRSHIP_PORT` | `7700` | Airship: its HTTP/WebSocket port |
| `AIRSHIP_HOST` | `127.0.0.1` | Airship: the address it listens on; anything but loopback needs `AIRSHIP_AUTH=token` |
| `AIRSHIP_DATA` | unset | Airship: one folder for the database, tokens, keys and backups |
| `AIRSHIP_DB` | `./airship.db`, or in `AIRSHIP_DATA` | Airship: the SQLite file |
| `AIRSHIP_AUTH` | `tailscale-serve` when `AIRSHIP_ALLOWED_USERS` is set | Airship: how it knows who a request is from: `tailscale-serve` or `token` |
| `AIRSHIP_TOKENS` | next to the database, or in `AIRSHIP_DATA` | Airship: the access-token file for `AIRSHIP_AUTH=token`. The `pnpm` `token:*` scripts use `./access-tokens.json` unless this is set |
| `AIRSHIP_ALLOWED_USERS` | unset | Airship: tailnet logins allowed to use the app (`Tailscale-User-Login`), comma-separated; required unless `AIRSHIP_AUTH=token` or `AIRSHIP_DEV=1` |
| `AIRSHIP_NODES` | unset, or in `AIRSHIP_DATA` | Airship: the node-token file; required unless `AIRSHIP_DATA` or `AIRSHIP_DEV=1` is set. The `pnpm` `node:*` scripts use `./nodes.json` unless this is set |
| `AIRSHIP_DEV` | unset | Airship: `1` starts a development hub open (no allow list or node tokens); `pnpm dev` does this itself |
| `AIRSHIP_VAPID_PATH` | next to the database, or in `AIRSHIP_DATA` | Airship: Web Push keys |
| `AIRSHIP_PUSH_SUBJECT` | `mailto:crystal-bridge@example.invalid` | Airship: the contact URL push services may use (`mailto:` or `https:`) |
| `AIRSHIP_CLI_CHECK` | on | Airship: `off` stops it asking npm for the latest Claude Code version |
| `AIRSHIP_BACKUP_DIR` | `./backups`, or in `AIRSHIP_DATA` | Airship: where database backups go. The `pnpm` `backup` script ignores `AIRSHIP_DATA`, so set this and `AIRSHIP_DB` for it |
| `AIRSHIP_BACKUP_KEEP` | `14` | Airship: how many backups to keep |
| `AIRSHIP_BACKUP_SSH` | unset | Backup mirror (`deploy/airship/push-backups.sh`): the off-box `user@host`; unset keeps backups local |
| `AIRSHIP_CLIENT_URL` | `ws://127.0.0.1:7700/client` | `pnpm smoke`: the hub to test against |
| `VITE_CB_THEME` | `crystal` | Web build: `classic` builds the plain theme |
