# Troubleshooting

Even a well-planned campaign hits trouble. Find your symptom below, and if it isn't here,
[file an Issue](#send-a-raven-file-a-useful-issue).

## Gone dark: a Kingdom shows offline

A Kingdom shows offline when its Crystal isn't connected to the hub. First check that the machine is awake. A Windows
Kingdom runs only while its user is signed in. Then look at Crystal on that machine:

| Kingdom | Log | Is it running? |
|---|---|---|
| Linux, from `join` | `journalctl --user -u crystal -n 50` | `systemctl --user status crystal` |
| Linux, from `deploy-crystal.sh` | The same: it's the same user service, and there's no log file | The same |
| macOS | `~/Library/Logs/crystal-bridge/crystal.log` | `launchctl print gui/$(id -u)/dev.crystal-bridge.crystal` |
| Windows | `%LOCALAPPDATA%\crystal-bridge\crystal.log` | `schtasks /Query /TN CrystalBridgeKingdom` |

If `journalctl --user` finds nothing, try `sudo journalctl _SYSTEMD_USER_UNIT=crystal.service -n 50`.

| The log says | What it means | What to do |
|---|---|---|
| `Unexpected server response: 401` | The hub doesn't know this token: the Kingdom was removed, or its token replaced | Put the new token in `crystal.env`, or run `leave` and add the Kingdom again |
| `Unexpected server response` with another status | Something in front of the hub isn't passing WebSocket upgrades | See the [nginx example](./SEVERAL-MACHINES.md#without-tailscale) |
| `hub socket error` with a network error | Crystal can't reach the hub | From that machine, open `<hub-url>/api/health`. Check the hub is up and, on a tailnet, that Tailscale is connected |
| `the hub refused this node` | Its protocol doesn't match the hub's | See [below](#wrong-tongue-the-hub-refuses-an-old-version) |
| `EADDRINUSE` at startup | Another copy already holds Crystal's local port | On Windows, see [Restarting a Kingdom](./OPERATIONS.md#restarting-a-kingdom) |

`/api/health` needs no login, and its `nodes` list shows which Kingdoms the hub sees. The hub's own log is at
`sudo journalctl -u airship -n 50` on a host the deploy scripts set up, and `docker logs crystal-bridge` for the container.
A hub that won't start says why in lines beginning `refusing to start`.

To restart a Kingdom, see [Restarting a Kingdom](./OPERATIONS.md#restarting-a-kingdom).

## Refused at the gate: `join` errors

`join` checks the machine before it spends the code, so after any of these you can fix the cause and run the same command
again, unless the code itself is the problem.

| Message | What to do |
|---|---|
| `This machine is already a Kingdom` | Run the `leave` command it prints, then run `join` again |
| `Claude Code is not installed here, or not on your PATH` | Install it, and check `claude --version` in the same shell |
| `Claude Code is not signed in on this machine` | Run `claude auth login` as this user |
| `The hub refused this join: that code is wrong, used or expired` | A code works once, for 10 minutes. Make a new one with **Add Kingdom** |
| `that name is taken` | Pick another name, or use **Remove** on the old Kingdom first |
| `this hub has no node tokens` | The hub needs `AIRSHIP_NODES` or `AIRSHIP_DATA`, so a `pnpm dev` hub can't add Kingdoms |
| `Too Many Requests` | Too many tries from this address. Wait a minute |
| `fetch failed` | This machine can't reach the hub. Check the address in the command and, on a tailnet, that Tailscale is connected |

If PowerShell says running scripts is disabled, see [Several machines](./SEVERAL-MACHINES.md#with-tailscale). If `join`
says it could not turn on lingering, the Kingdom stops when you log out until you run the `loginctl` command it prints.

## Wrong tongue: the hub refuses an old version

A hub and a Kingdom have to speak the same protocol version, whatever their releases
([Compatibility](./OPERATIONS.md#compatibility)). When they don't, the Kingdom shows offline, keeps retrying, and its log
says `the hub refused this node: protocol v1 not supported; this hub speaks v2`. Updating the older side ends the refusal.
`/api/health` shows the hub's `protocol`.

- **The hub is older:** update it ([packaged](./OPERATIONS.md#running-a-packaged-hub), or
  [from a deploy](./OPERATIONS.md#moving-onto-packages)).
- **The Kingdom is older:** it can't update itself, because the hub names a version only to a Kingdom it accepted. On Linux
  and macOS, run [`adopt`](./OPERATIONS.md#moving-onto-packages) on the machine with the hub's version. On Windows, run
  `leave` and add the Kingdom again.

A hub that says `database schema vN is newer than this Airship` is a release older than its database. See
[Rolling back](./OPERATIONS.md#rolling-back).

## Hold the line: updates waiting on a busy Quest

The Castle says "`<version>` is ready: this Kingdom restarts on it once no Quest here is busy", and the Ship's Log says it
"waits for its Quests". That's normal, and it needs nothing from you. A Quest counts as busy while it's mid-turn, waiting on
an approval, or holding a background command or agent. A Monitor doesn't hold an update.

To move it along, answer what's waiting, let the turn finish, or ask the Quest to wrap up its background work. The Kingdom
restarts within about a minute of going quiet, and idle Quests resume on their next follow-up.

The deploy scripts wait in the same way, name each busy Quest, and exit with status 3 if time runs out. Run them again
later. `--force` cuts the turns off ([Deploying](./OPERATIONS.md#deploying)).

If the Castle says "Could not update", it gives the reason and tries again in an hour. On Windows, check that `npm` is
[beside `node.exe`](./OPERATIONS.md#kingdoms-that-update-themselves).

## Failed to set out: Quests that won't start

| You see | What to do |
|---|---|
| `node offline` | The Kingdom isn't connected. See [above](#gone-dark-a-kingdom-shows-offline) |
| Your project isn't in New Quest | It lists repositories under `CRYSTAL_PROJECT_ROOTS` (default `~/code`). Set that in `crystal.env` and restart the Kingdom |
| `working directory not found` | The folder was moved or deleted |
| `spawn claude ENOENT` | Crystal's service can't find `claude`. Add `CLAUDE_BIN=<full path>` to `crystal.env` and restart the Kingdom |
| `could not create a worktree` | The rest of the message is git's. Check the folder is a repository with at least one commit |
| `this node does not run the interactive engine` | Add `CRYSTAL_ENGINES=stream,interactive` to `crystal.env` and restart the Kingdom |

If a Quest starts and fails at once, run `claude auth status` on that machine as Crystal's user, then `claude -p "hello"` in
the same folder. That shows the CLI's own error without the bridge in the way.

## Send a raven: file a useful Issue

Use the [bug report form](https://github.com/crystal-bridge/crystal-bridge/issues/new/choose). The most useful reports have:

- What you did, what you expected and what happened.
- The hub's release (`/api/health`) and the Kingdom's (on its Castle).
- The OS, `node -v` and `claude --version` on the machines involved.
- How each part was installed: `pnpm dev`, the deploy scripts, a package, the container or `join`.
- Which login: Tailscale or token.
- The log lines from around that moment, from the places above.

Issues are public, so scrub what you paste:

- **Tokens and codes:** `CRYSTAL_TOKEN`, access tokens, join codes and setup codes. Never paste `crystal.env` or
  `airship.env` whole. If a token gets out, [replace it](./SECURITY-MODEL.md#what-a-compromise-of-each-part-gives-an-attacker).
- **Names:** host names, tailnet names and IP addresses. Use placeholders such as `hub-host`.
- **Personal details:** logins, email addresses, and home paths with your user name in them.
- **Your work:** project names, prompts and tool output.

For a security problem, don't open an Issue: see [`SECURITY.md`](../SECURITY.md).
