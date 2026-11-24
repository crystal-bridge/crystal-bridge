# Configuration reference

Crystal Bridge is configured with environment variables. A Kingdom reads `~/.config/crystal-bridge/crystal.env`
(`%LOCALAPPDATA%\crystal-bridge\crystal.env` on Windows), which `join` and the deploy scripts write; a hub from the deploy
script reads `/etc/crystal-bridge/airship.env`. A change takes effect when that process restarts:
[restart a Kingdom](./OPERATIONS.md#restarting-a-kingdom), or run `sudo systemctl restart airship` on the hub. Commented
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
| `CRYSTAL_DEFAULT_MODE` | `manual`; `join` and the deploy scripts write `auto` | Crystal: permission mode for a session that arrives without one. An unknown value also means `manual`. New Quest always sends the mode picked in the app (Auto unless this device chose another), so this reaches only Quests adopted with Recruit |
| `CRYSTAL_PROJECT_ROOTS` | `~/code` | Crystal: where the New Quest picker looks for repos (separated like `PATH`: `:`, or `;` on Windows) |
| `CRYSTAL_CLOSING_MODEL` | unset | Crystal: passed as `--model` to the call at Close that writes a Quest's Deeds, to use a cheaper model than the account's default ([Deeds](./DEEDS.md)) |
| `CRYSTAL_CLOSING_BUDGET_USD` | `1` | Crystal: `--max-budget-usd` for that call, a backstop: the CLI checks it after the call, so a call over it is billed in full and writes nothing |
| `CRYSTAL_CHROME` | unset | Crystal: `1` starts sessions with `--chrome` |
| `CRYSTAL_ENGINES` | `stream` | Crystal: `stream,interactive` enables the interactive engine; `stream` is always on |
| `CRYSTAL_SUMMONS` | unset | Crystal: machines its Quests may run jobs on, as SSH host names, comma-separated, each with an optional `name=` and `/limit` of Casts at once. Crystal rereads it from `crystal.env` with no restart; see [Summons](SUMMONS.md) |
| `CRYSTAL_SCOUTS_DIR` | `~/.crystal-bridge/scouts` (`%USERPROFILE%\.crystal-bridge\scouts` on Windows) | Crystal: the folder holding one folder per Scout; each Scout's schedule state is kept beside it, in `<folder name>-state.json` (`scouts-state.json` by default). See [Scouts and Boards](SCOUTS.md) |
| `CRYSTAL_LIBRARY_DIR` | `~/.crystal-bridge/library` (`%USERPROFILE%\.crystal-bridge\library` on Windows) | Crystal: the folder holding the Kingdom's Library, made with mode 0700 on start. `off` turns the Library off, and the hello then says the Kingdom has none. See [The Library](LIBRARY.md) and [Security model](SECURITY-MODEL.md#the-library) |
| `CRYSTAL_LIBRARY_QUESTS` | unset | Crystal: `folder` adds the Library folder to every Quest's folders, resumed Quests included. Without it, a Quest's permission mode decides, as for any folder outside its project. See [The Library](LIBRARY.md) |
| `CRYSTAL_PID_FILE` | unset; Windows' `crystal.cmd` sets it | Crystal: where to record its process id, so `leave` can stop it |
| `CRYSTAL_LOGIN_SHELL` | `$SHELL`, then `/bin/bash` | Crystal: the shell whose login environment sessions get; `join` writes it |
| `CRYSTAL_SESSION` | set by Crystal | Not a setting: the session id on each `claude` process, so a hook can tell it runs under the bridge |
| `CRYSTAL_PATROLS_DIR` | `~/.crystal-bridge/patrols` (`%USERPROFILE%\.crystal-bridge\patrols` on Windows) | Crystal: the folder holding one folder per Patrol; each Patrol's schedule state is kept beside it, in `<folder name>-state.json` (`patrols-state.json` by default). See [Patrols](PATROLS.md) |
| `CRYSTAL_PATROLS_FROM_APP` | on | Crystal: `off` stops the app creating or editing Patrols on this Kingdom; pausing, resuming, deleting and Run now still work. See [Patrols](PATROLS.md#edit-from-the-app) |
| `CRYSTAL_PATROL` | set by Crystal | Not a setting: a script Patrol gets its Patrol id |
| `CRYSTAL_PATROL_RUN` | set by Crystal | Not a setting: a script Patrol gets the id of the run it is |
| `CRYSTAL_SCOUT` | set by Crystal | Not a setting: a Scout's collector and action scripts get its Scout id |
| `CRYSTAL_SCOUT_ACTION` | set by Crystal | Not a setting: a Scout's `run` action script gets the action's key |
| `CRYSTAL_SCOUT_STATE` | set by Crystal | Not a setting: a Scout's collector gets the `state` folder it may keep its own state in, which Crystal creates and never reads |
| `CRYSTAL_SELF_UPDATE` | on | Crystal: `off` stops a Kingdom installed by `join` updating itself |
| `CRYSTAL_DRAIN_SECONDS` | `600` | Crystal deploy scripts: how long to wait for running turns before giving up |
| `CLAUDE_BIN` | `claude` | Crystal: the CLI it runs |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Crystal: where the CLI keeps its session transcripts, for finding sessions |
| `AIRSHIP_PORT` | `7700` | Airship: its HTTP/WebSocket port. Leave it alone under `pnpm dev`: the web dev server's proxy always points at 7700 |
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
| `AIRSHIP_KINGDOM_VERSION` | the hub's own version | Airship: the release self-updating Kingdoms move to, or `off` for none. A hub run from git has no version of its own |
| `AIRSHIP_CLI_CHECK` | on | Airship: `off` stops it asking npm for the latest Claude Code version |
| `AIRSHIP_RELEASE_CHECK` | on | Airship: `off` stops a packaged hub asking GitHub for this project's latest release |
| `AIRSHIP_UPDATE_REQUEST` | unset | Airship: where the hub asks its updater for a release. The packaged units set it to `/var/lib/airship/update-request.json`; unset, the Ship's Log says how to update by hand ([Updating the hub from the app](./OPERATIONS.md#updating-the-hub-from-the-app)) |
| `AIRSHIP_UPDATE_STATUS` | `/var/lib/airship-update/status.json` | Airship and its updater: where the updater says how an install is going, in a folder only root writes |
| `AIRSHIP_INSTALL_ROOT` | `/opt/crystal-bridge` | Airship's updater: the folder holding `releases/` and `current` |
| `AIRSHIP_USER` | `airship` | Airship's updater: the hub's user, which a new release is first run as |
| `AIRSHIP_BACKUP_DIR` | `./backups`, or in `AIRSHIP_DATA` | Airship: where database backups go |
| `AIRSHIP_BACKUP_KEEP` | `14` | Airship: how many backups to keep, at least one |
| `AIRSHIP_BACKUP_SSH` | unset | Backup mirror (`deploy/airship/push-backups.sh`): the off-box `user@host`; unset keeps backups local |
| `AIRSHIP_CLIENT_URL` | `ws://127.0.0.1:7700/client` | `pnpm smoke`: the hub to test against |
| `VITE_CB_THEME` | `crystal` | Web build: `classic` builds the plain theme |
