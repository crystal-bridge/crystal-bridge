# Operating Crystal Bridge

How to change the running system without breaking work in progress. The machines and their roles are in
[Several machines](./SEVERAL-MACHINES.md); this is the procedure. Host names here are placeholders: `hub-host` is the Airship's SSH
host, `node-a-host`/`node-b-host` the Kingdoms'.

## The rules

- **Production runs `main`.** Develop and try changes locally (`pnpm dev`, `pnpm smoke`), merge, then deploy. The
  deploy scripts refuse anything but a clean, pushed `main`; `--branch` exists for a deliberate experiment.
- **Keep changes additive across the node link.** New optional fields and new event types are fine; old peers ignore
  them. Only a change an older peer can't handle bumps `PROTOCOL_VERSION`, and then the hub refuses old nodes with a
  clear reason instead of half working.
- **Never edit a shipped migration.** Append a new one to `apps/airship/src/migrations.ts`.

## Compatibility

A hub and a Kingdom work together when they speak the same `PROTOCOL_VERSION`, whatever their releases. Changes inside
a protocol version are additive, so either side can be updated first; updating the hub first is the habit.

Additive means an older peer carries on past what it doesn't know:

- **New event types.** A hub stores and acks a type it doesn't know, and relays it. A tab skips any event it can't read,
  on its own, and shows the rest of the Quest.
- **New commands and values.** A Kingdom that can't read a command drops it, logging only the command's name, and
  answers with an error for that Quest, so the tab doesn't wait.
- **New Appearance fields.** A tab or hub keeps the fields it doesn't know when it saves the rest.

These hold from the release after 0.5.1. Older releases refuse what they don't know.

A change an older peer can't handle bumps the version. The hub then refuses a Kingdom on another version instead of half
working: both sides log the reason, and the Kingdom shows as offline and keeps retrying, backing off to one try every 30
seconds, so updating the older side ends the refusal without touching the other. A Kingdom that updates itself hears
which version to run before it's refused, so it crosses the bump alone. A release's notes say when it bumps the protocol.

The Castle shows each Kingdom's release. A packaged Kingdom reports its version, and one deployed from git its commit.
The Castle warns when a Kingdom's version is older than the hub's. Commits can't be ordered, so it never warns about a
Kingdom or hub deployed from git. `GET /api/health` reports the hub's release and protocol version.

## Claude Code versions

Each Kingdom reports the version of its `claude` CLI on connecting, then within about an hour of a change. The Castle
shows it and says when a newer one is out. To know that, the hub asks npm's public registry for the latest version at
most every six hours, sending nothing about you or your sessions. If the registry can't be reached it keeps the last
answer. `AIRSHIP_CLI_CHECK=off` stops the check.

When a Kingdom is behind, its Castle offers **Update Claude Code**. That runs the CLI's own `claude update` on that
machine, under that machine's login, which also hands off to a package manager if one installed the CLI. The Kingdom
refuses while a Quest there is busy, and runs one update at a time. A Quest that's already running keeps its version
until its process next starts. The update gets five minutes and can't take input, so one that needs a password, such
as a package manager asking for `sudo`, fails with its last output: update that machine by hand. Kingdoms older than
this button don't offer it.

The notice reads npm, and `claude update` reads the install's own release channel, which can trail npm for a while
after a release. The button then says "Still on" that version and stays until the channel catches up.

## Deploying

The simplest way is one command, driven by a config file outside the repo (so your host names are never committed,
and every clone and worktree sees it):

```sh
# ~/.config/crystal-bridge/deploy.env
HUB_HOST=hub-host                                  # the hub's SSH host
KINGDOMS="node-a-host:node-a node-b-host:node-b"   # ssh-host:node-id for each Linux Kingdom
LOCAL_NODE=macbook                                 # optional: this Mac's node id, deployed with --when-idle
```

```sh
scripts/deploy-all.sh             # hub, then each Kingdom, then this Mac when idle
scripts/deploy-all.sh --dry-run   # print the commands only
scripts/deploy-all.sh --kingdoms-only --force
```

Run with no config, it says what to put in the file. Under the hood it runs the per-machine scripts below, which
you can also call directly. Deploy the hub first, then the Kingdoms (old and new versions interoperate either way):

```sh
scripts/deploy-airship.sh hub-host
scripts/deploy-crystal.sh node-a-host node-a hub-host     # <ssh-host> <node-id> <hub-ssh-host>
scripts/deploy-crystal.sh node-b-host node-b hub-host
scripts/deploy-crystal-macos.sh macbook hub-host          # this Mac as a Kingdom (run on the Mac, from a terminal)
```

A Mac Kingdom runs Crystal as a launchd user agent (`~/Library/LaunchAgents/dev.crystal-bridge.crystal.plist`, logs
in `~/Library/Logs/crystal-bridge/crystal.log`) on port 7711, so it doesn't clash with `pnpm dev`. The script
refuses to run from inside a Quest on that same Mac (its own turn would block the wait); run it from a terminal
between turns, or schedule it from the Quest with `--when-idle`:

```sh
scripts/deploy-crystal-macos.sh macbook hub-host --when-idle   # from a Quest on this Mac
tail -f ~/Library/Logs/crystal-bridge/deploy.log
```

`--when-idle` pins the commit (the pushed main, or the checkout with `--branch`) and hands the deploy to a one-off
launchd job, `dev.crystal-bridge.deploy-when-idle`, outside the Crystal job so the restart doesn't kill it. The job
deploys from a temporary worktree at that commit, waiting up to an hour (`CRYSTAL_DRAIN_SECONDS=3600`) for every
session to be idle, then removes its worktree, plist and itself. The scheduling Quest ends its turn, Crystal
restarts while it's idle, and the next follow-up resumes it. A running background command or agent keeps it waiting,
as for any deploy. Only one can be scheduled at a time; cancel one with
`launchctl bootout gui/$(id -u)/dev.crystal-bridge.deploy-when-idle` and remove its plist from
`~/Library/LaunchAgents`. `--when-idle --dry-run` runs the same hand-off under the `.dry-run` label but only logs the
deploy it would run.

On a Kingdom whose user runs Chrome with the Claude extension signed in (typically a Mac), add `CRYSTAL_CHROME=1`
to `~/.config/crystal-bridge/crystal.env` and redeploy: every Quest there starts with `--chrome`. Deploys keep the
line.

**Interactive engine (preview).** `CRYSTAL_ENGINES=stream,interactive` in the same env file lets New Quest on that
Kingdom offer "Interactive": the real interactive `claude` in a pseudo-terminal (`apps/crystal/src/interactive.ts`),
for the tools only interactive sessions get, artifacts above all. Approvals and questions use the same cards, through
a PermissionRequest hook in a generated `--settings` file that calls Crystal's local port; replies are read from the
session's transcript, a format the CLI calls internal, so check an interactive Quest after each CLI update. The node
needs `curl`. Recruits offers the same engine choice, and a Quest keeps its engine: the hub names it in the resume it
sends, so after a Crystal restart a follow-up resumes on the same engine (and a node that no longer runs that engine
refuses rather than switching quietly). Not yet: cost and token Stats, and the Inventory's Items, Equipment, Guild and Abilities (it lists Spells and Runes).

A Quest's Effort can change from its prompt bar, on either engine. The CLI takes it only when a process starts, so nothing
running changes: the next message moves to a new process with it and the conversation carries on, which shows as the
usual idle stop and resume. A turn in progress finishes first, and a Quest holding background work stays on its process
until that's gone, because a restart would kill the work.

An interactive Quest's permission mode moves the same way, because a running interactive `claude` can't change it from
outside. Until that next message the process stays in its old mode, so tightening a mode doesn't reach a turn already
running, background work still going, or a turn the CLI starts by itself on an idle Quest. The Quest says so if it's busy
when you change it. The stream engine switches a live process at once.

An interactive terminal can show screens the bridge can't read, such as a setup dialog or an offer, and new ones come
with CLI updates. Crystal first tries Esc when a screen offers it, then one restart. If the terminal still won't take a
message, or a new process doesn't reach its input box within 45 seconds, or the CLI says a prompt is terminal-only, the
Quest shows a card with the live screen. Its buttons and text field send keystrokes, and it counts as needing you in
notifications and waiting counts. Keys are refused unless a card is open, so they stay an answer to a dialog and not a
way to drive a Quest. A follow-up sent while a card is open waits and goes in once the card closes, and Stop drops it.
The screen's text is stored with the Quest's events. A card nobody touches ends the turn after 10 minutes
with an error quoting the screen, so a stuck Quest doesn't hold deploys forever. A terminal-only prompt from the CLI
waits instead, as an approval does.
Deploys keep the line.

- A hub deploy is a few seconds of downtime. Crystals and browser tabs reconnect on their own, and tabs then offer
  "Crystal Bridge was updated · Reload".
- A Crystal deploy waits until no session on that node is mid-turn (including ones waiting on an approval), for up
  to `CRYSTAL_DRAIN_SECONDS` (default 600). If they're still busy it changes nothing and exits 3; re-run later, or
  pass `--force` to cut the turns off. While it waits it names each busy session and why (a turn open and for how
  long, a typed message the terminal hasn't taken, or background tasks). Idle sessions survive the restart and
  resume on the next follow-up.
- A Quest with a background command or agent running counts as busy until the CLI reports that work finished or
  stopped, and so does the turn the CLI starts to pick up the news. A long job therefore holds Crystal deploys on its
  node: they wait, then exit 3. Deploy the hub freely; for the Crystal, wait for a quiet moment or ask the Quest to
  wrap up, and use `--force` only when cutting its background work off is acceptable (its conversation still resumes).
- A Quest with a Monitor running is never idle-stopped, but it doesn't hold a deploy or an update: a persistent Monitor
  never ends, and the Quest can start it again after a restart.

A Quest cut off mid-turn all the same, by `--force`, a crash, a reboot or a Quest restarting Crystal itself, comes back by
itself. When the Kingdom reconnects, the hub sees that it no longer holds a Quest whose turn never finished, records the
cut, and starts a new turn telling the agent what happened, in the Quest's own permission mode. That turn costs plan usage
like any other. It stops there instead, and you're notified, if the cut was more than 30 minutes ago, if the turn cut off
was already such a turn, or if the Quest started before its mode was recorded. A follow-up then carries on as usual. A turn
the CLI started by itself, when background work reported in, isn't noticed, because nothing marks its start on the hub,
unless it was waiting on an approval: then the hub records the cut and stops there. A Quest stops counting as waiting
while its Kingdom is offline, since nobody can answer it, so a removed or dead Kingdom leaves nothing waiting for good.

A Crystal restart stops only Crystal's own process (`KillMode=process`): Crystal closes its `claude` sessions on
SIGTERM, and anything a Quest deliberately left running in the background (detached workers, long jobs) keeps
running. Before this, a deploy killed every process in the service's cgroup, detached or not. Those jobs still belong to
the service, so each stop logs a "left-over process" warning for them. That's harmless, and a long job run as a Cast on
`here` avoids it ([Summons](SUMMONS.md)).

## Running a packaged hub

A release has the hub as a container (`ghcr.io/crystal-bridge/airship`, for amd64 and arm64) and a tarball. Both are for
token login, with HTTPS in front. The image defaults to `AIRSHIP_AUTH=token`, `AIRSHIP_HOST=0.0.0.0` and `AIRSHIP_DATA=/data`,
and runs as a non-root user. Without Docker:

```sh
export AIRSHIP_AUTH=token AIRSHIP_DATA=~/crystal-bridge-hub
npx --yes --package=https://github.com/crystal-bridge/crystal-bridge/releases/download/v<version>/crystal-bridge-airship-<version>.tgz crystal-bridge-airship
```

`<version>` is a release from the [Releases page](https://github.com/crystal-bridge/crystal-bridge/releases), such as
`0.5.1`.

Everything the hub keeps is in `AIRSHIP_DATA`, so back up that folder and keep it across upgrades. The hub refuses to
listen on anything but loopback without token login. `crystal-bridge-airship backup` copies the database into its backups
folder safely while the hub runs, keeping the newest `AIRSHIP_BACKUP_KEEP` (and always at least the one it just made). The
database and each backup are readable by their owner only (0600), whatever the umask, so a tool that reads them as another
user needs to run as the hub's.

Updating a packaged hub is a step outside the app, because a hub can't replace what's running it: pull the newer image
and recreate the container, or start the newer tarball. A browser tab then offers to reload, and Kingdoms made by `join`
follow on their own.

## The Ship's Log

The **Ship's Log** on the Airship shows the hub itself: its release, how its Kingdoms are getting on and, one click
further, its protocol version, uptime, database size, and last backup and mirror. It stays one line until something
needs a look. It's left off phones for now.

A packaged hub asks GitHub for this project's latest full release at most every six hours, sending nothing about you or
your sessions, and keeps the last answer if GitHub can't be reached. When a newer one is out, the Ship's Log shows its
notes and how to take it, and the logo that leads to the Airship gets a count badge. `AIRSHIP_RELEASE_CHECK=off` stops the
check. A hub run from git has no version to compare, so it never asks.

Each Kingdom's line shows when it's behind, when it has a release ready and is waiting for its Quests to finish, and why
an update failed. The mirror's age turns amber after two days, which needs `push-backups.sh` from this release or newer:
it leaves a `last-mirror` file in the backups folder.

## Logging in

`AIRSHIP_AUTH` picks how the hub knows who a request is from. `tailscale-serve` trusts the identity header, so put nothing else in front of the hub. `token` is the hub's own login and works behind any HTTPS proxy. Add a token per person or device on the hub:

```sh
# A hub from deploy-airship.sh, whose data only the airship user can read:
cd /opt/crystal-bridge/current/apps/airship
sudo -u airship env AIRSHIP_TOKENS=/var/lib/airship/access-tokens.json ../../node_modules/.bin/tsx src/tokens-cli.ts add laptop

# A packaged hub, run with the same AIRSHIP_DATA as the hub:
crystal-bridge-airship token add laptop

# The container:
docker exec crystal-bridge crystal-bridge-airship token add laptop
```

It's shown once, and the login page takes it. In place of `add laptop`, `list` shows the names, and `remove <name>` revokes one. Requests with it are refused at once, and a tab already open is closed at its next heartbeat, within 30 seconds. In a checkout, the `pnpm` scripts `token:add`, `token:list` and `token:remove` do the same. Each name has its own synced appearance. Moving a hub from `tailscale-serve` to `token` starts appearances again, because they're stored per login.

On `tailscale-serve` the allow list is `AIRSHIP_ALLOWED_USERS`, read when the hub starts, so removing a login means editing it and restarting the hub, and that closes every tab anyway.

### First run

A hub on token login with no logins starts locked and prints a one-time setup code to its logs. Open the hub, enter
the code and a name, and it makes your login, logs that browser in and shows the token once. Nothing else opens
while it waits: `/api` and `/client` stay closed. The code is kept in memory and a restart makes a new one. It works
once, and stops working as soon as any login exists, so `token add` still works for a scripted setup.

Two optional steps follow: naming the hub and adding the first Kingdom. Both are also in Config, and a hub on
`tailscale-serve` has them there. The name is in `hub.json` beside the access tokens, shows in the app bar and page
title for everyone on the hub, and isn't in the nightly database backup.

Log out in Config ends that browser's login. It doesn't revoke the token: use `token:remove` for that.

## Joining and leaving

A machine can join without SSH or a checkout. Add Kingdom in Config makes a one-time code and shows the command to run
there (`joinCommand` in `packages/protocol`). The hub needs `AIRSHIP_NODES` for this. That command is
`crystal-bridge-kingdom join <hub-url> <code>`, which checks that Node is 22 or newer, that Claude Code is
installed and signed in (it reads only the `loggedIn` field of `claude auth status`), that the service manager can be
reached (`systemctl --user`, launchd's session for this user, or Task Scheduler, which it has take a throwaway task) and
that port 7711 is free. It then copies itself to `~/.local/share/crystal-bridge/releases/<version>`, because npx's own
copy is temporary. Only then does it spend the code, write the token to `~/.config/crystal-bridge/crystal.env` (mode
0600) and start a systemd user unit or launchd agent. It refuses a machine that's already a Kingdom. On Linux it runs
`sudo loginctl enable-linger` once, and says so, so the service survives logging out.

`join` then waits about 20 seconds for the Kingdom to answer on that port under its own name. If it doesn't, `join` fails
and says where the log is: `journalctl --user -u crystal.service` on Linux, and the log file elsewhere. The code is spent
by then, so a slow start can still come good, and otherwise the way to start over is `leave`. The port is fixed, so one
machine holds one Kingdom: a second account on it is refused.

On Windows the same steps use `%LOCALAPPDATA%\crystal-bridge`: the copy goes in `current`, the token in `crystal.env`
and the log in `crystal.log`. A Task Scheduler task runs `crystal.cmd` at the user's sign-in, in a headless console, and
that script restarts Crystal after a crash. This needs no administrator, and it means the Kingdom runs only while that
user is signed in. The folder is private to the user by default. The task names the user by the first form Task Scheduler
takes: the SID, then the account name `whoami` gives, then the plain user name, because a plain name can match nothing on
an Entra-joined or domain PC. To restart it, see [Restarting a Kingdom](#restarting-a-kingdom).

`leave` (`LEAVE_COMMAND`, or `LEAVE_COMMAND_WINDOWS`, in `packages/protocol`) gives up the token and removes the service, the env file and the
install. It works even if the hub can't be reached, and then says to remove the Kingdom from the app as well. Remove on
a Castle does the hub's half: it revokes the token and cuts the connection, and shows that command to run on the
machine. A removed Kingdom's Quests stay as history, so its tab stays until you hide it in Config or forget it.

Forget, on a removed Kingdom's Castle, is optional and can't be undone: once you type the Kingdom's name it deletes
that Kingdom's Quests from the hub (sessions, events and relay counts), and the tab goes with them. The hub refuses
while the Kingdom holds a token or a connection. It deletes only the hub's copy: transcripts stay on the machine, and
existing backups keep the Quests until they age out.

### Restarting a Kingdom

A change to `crystal.env` takes effect when Crystal restarts. A restart cuts off any turn in progress, so pick a quiet
moment. Quests come back [as they do after a deploy](#deploying).

```sh
systemctl --user restart crystal                                 # Linux
launchctl kickstart -k gui/$(id -u)/dev.crystal-bridge.crystal   # macOS
```

On Windows, stop the process recorded in `crystal.pid`, and `crystal.cmd` starts Crystal again about five seconds later.
In PowerShell:

```powershell
Get-Process -Id (Get-Content "$env:LOCALAPPDATA\crystal-bridge\crystal.pid") | Where-Object ProcessName -eq node | Stop-Process
```

If that finds no process, or Crystal doesn't come back, start it with `schtasks /Run /TN CrystalBridgeKingdom`. Don't use
`/Run` to restart a running Crystal: `schtasks /End` ends only the console and leaves Crystal running, and a `/Run` after
it starts a second copy that can't bind the port (7711). That copy keeps retrying and logs `EADDRINUSE` in `crystal.log`
until you sign out and back in.

## Kingdoms that update themselves

A Kingdom made by `join` follows its hub. A packaged hub names its own version to its Kingdoms, and each one moves to
it alone, so updating the hub brings them along. A hub run from git, which is what `deploy-airship.sh` and the Tailscale
route in [Several machines](./SEVERAL-MACHINES.md) give you, has no version and names none, so its Kingdoms never follow.
To change that, put the hub on a release with [`deploy-airship-package.sh`](#moving-onto-packages), or set
`AIRSHIP_KINGDOM_VERSION`, which also picks another version, or `off` to name none. Naming none also stops an update
that hasn't swapped yet, once that Kingdom next connects.

The Kingdom takes only a version number from the hub. It then:

1. Downloads that release's package from this project's GitHub Releases.
2. Checks its build provenance itself: the attestation published with the release, signed through Sigstore, has to
   name this project's release workflow at that version's tag and that exact file. See
   [the security model](./SECURITY-MODEL.md).
3. Installs it beside the running release with `npm install --ignore-scripts`, and runs the new copy once to see that
   it loads. Everything so far leaves the running Kingdom alone. It needs `npm`: on Crystal's PATH on Linux and macOS,
   and on Windows beside `node.exe` (`node_modules\npm` in that folder), where the Node.js installer puts it. On Windows,
   being on PATH isn't enough.
4. Waits until no Quest there is busy, as a deploy does. A Quest with a background command or agent running counts as
   busy.
5. Swaps to it and restarts. Idle Quests resume on their next follow-up.

The Castle shows each step. If one fails, it says why, the Kingdom stays on its version and tries again in an hour.
Releases before 0.3.0 don't carry the attestation, so a Kingdom updating to one asks GitHub's API, where machines
sharing an address can reach the limit of 60 anonymous calls an hour ("GitHub answered 403").

A Kingdom never moves to an older version, whatever the hub names. To go back, run this on the machine:

```sh
node ~/.local/share/crystal-bridge/current/node_modules/@crystal-bridge/kingdom/dist/main.js rollback
cmd /c node "%LOCALAPPDATA%\crystal-bridge\current\node_modules\@crystal-bridge\kingdom\dist\main.js" rollback
```

The first line is Linux and macOS, the second Windows. That returns to the release kept by the last update and restarts.
The Kingdom won't take a release it left this way again, but it will take a newer one. There's no automatic rollback:
a release that loads and then fails needs that command, so keep a way onto the machine.

`rollback` records the release it left in a file called `held-version`, one version a line, in
`~/.local/share/crystal-bridge` (`%LOCALAPPDATA%\crystal-bridge` on Windows). To take that release again, delete its line
or the file, and [restart the Kingdom](#restarting-a-kingdom).

To stop a Kingdom updating itself, add `CRYSTAL_SELF_UPDATE=off` to its `crystal.env` and
[restart it](#restarting-a-kingdom). Kingdoms installed any other way (the deploy scripts, npm, a checkout) never update
themselves: the Castle only warns when one falls behind. [Moving onto packages](#moving-onto-packages) brings one over.

### When the service can't find Node

The service names the Node it runs on. `join` writes a link on PATH that leads to the Node running it, such as Homebrew's
`bin/node`, which survives upgrades, and writes that Node's own path when there's no such link. Homebrew's own path is
in a folder named after the version (`Cellar`), so with an older `join`, `brew upgrade node` and the next restart left
launchd unable to start the Kingdom.

An update doesn't rewrite the service, so a Kingdom keeps the path it has until you repair it. On Linux and macOS, run
`adopt` from a release newer than 0.5.1, because older ones write the versioned path again:

```sh
npx --yes --package=<kingdom-tarball-url> crystal-bridge-kingdom adopt
```

That moves the Kingdom to that release and rewrites its service, keeping the env file, as in
[Moving onto packages](#moving-onto-packages). It works with the Kingdom stopped too. On Windows `adopt` refuses, so
repairing means `leave` and `join` again, which gives the machine a new token.

### Choosing when Kingdoms update

A packaged hub tells its Kingdoms to run its own version, so they follow it on their own. To decide when instead, set
**Kingdom updates** to **When approved** in the Ship's Log's details. That freezes the version the hub names, so nothing
moves. After you update the hub, the Ship's Log offers **Update Kingdoms to** that version, and the logo's badge counts
it. Anyone logged in can do both, because a login already has the run of every Kingdom. The choice lives in `hub.json`,
so it survives a restart and a move between releases, and setting it back to **Automatic** sends Kingdoms on to the hub's
version.

This only changes which version the hub names. Each Kingdom still checks that release itself and only moves forward, so
approving can't make a Kingdom run anything but a genuine, newer release. It works alongside the two settings that stop
updates outright: `AIRSHIP_KINGDOM_VERSION=off` on a hub, which removes the choice, and `CRYSTAL_SELF_UPDATE=off` on a
Kingdom.

## Moving onto packages

The deploy scripts above run a checkout of `main`. A host they set up can move to published releases in place, keeping
its data, logins, token and Kingdom name. Kingdoms then follow the hub, and updating the hub is the one step left.
Nothing needs this: a checkout deploy keeps working, and suits running `main` ahead of the releases.

Move the hub first. Run this from a checkout, which needs `gh` signed in, to fetch a release, check its provenance and
put it on the host:

```sh
scripts/deploy-airship-package.sh hub-host <version>
```

It keeps the env file, `/var/lib/airship`, the nightly backups and `tailscale serve`, so the address and every browser's
settings stay as they are. Only the program changes. If the new hub doesn't come up, it restores the old one. Run it with
a newer version to update the hub, or an older one to go back, as long as the database is no newer than that version.
It refuses the version already live, and a failed install leaves every release as it was.

Going back across 0.5.0 costs some history in the view. A 0.4.x hub relays the `session.mode` rows a later hub stored,
but its own web bundle can't parse them, so it drops each replay batch holding one, and a Quest with a mode change loses
history in the view while the hub is rolled back. Nothing is lost from the database. Hubs after 0.5.1 store types they
don't know and their tabs skip what they can't read, so rolling back to one of those doesn't do this for later types.

Then move each Kingdom, on that machine:

```sh
npx --yes --package=https://github.com/crystal-bridge/crystal-bridge/releases/download/v<version>/crystal-bridge-kingdom-<version>.tgz crystal-bridge-kingdom adopt
```

`adopt` waits up to an hour for Quests to finish, swaps the service to the package and restarts. The env file stays as it
is, so the token, name and settings such as `CRYSTAL_ENGINES` carry over, and Quests resume on their next follow-up. Run it
over SSH or from a terminal, not from a Quest on that machine, which would wait for itself. Use the same PATH the machine's
own shell has, so `npx` is found: over SSH, `bash -lic '...'`. It's for Linux and macOS, the deploy scripts' platforms.

To go back to a checkout, run `deploy-airship.sh` or `deploy-crystal.sh` as usual: each rewrites the service. `--rollback`
doesn't, so it can't cross between the two.

## Rolling back

```sh
scripts/deploy-airship.sh hub-host --rollback
scripts/deploy-crystal.sh <host> <node-id> hub-host --rollback
```

This switches to the most recent other kept release (each host keeps three) and restarts, with the same health
check or drain as a deploy. A second `--rollback` undoes the first.

If the hub refuses to start after a rollback with "database schema vN is newer than this Airship", the release you
rolled back to predates a migration. Roll forward again, or restore the backup taken before that migration (below).

## Backups and restore

- `airship-backup.timer` copies the database nightly to `/var/lib/airship/backups` (newest 14 kept) and mirrors that
  folder to an off-box backup host (set up with `scripts/airship-offsite-setup.sh`).
- The hub also backs up before applying any migration.

To restore on the hub host:

```sh
sudo systemctl stop airship
sudo -u airship cp /var/lib/airship/backups/airship-YYYYMMDD-HHMMSS.db /var/lib/airship/airship.db
sudo rm -f /var/lib/airship/airship.db-wal /var/lib/airship/airship.db-shm
sudo systemctl start airship
```

A restore loses only what happened after that backup; Crystals resend events the hub never acknowledged.

## Web Push

- The hub makes a VAPID key pair on first start at `/var/lib/airship/vapid.json` (owner-only; `AIRSHIP_VAPID_PATH`
  overrides it). It lives outside the releases, so deploys and rollbacks keep it. The nightly backup copies only the
  database, so the private key never leaves the hub host; if the file is lost, the hub makes a new pair and each device
  has to turn "Push to this device" off and on again.
- Subscriptions and each device's prefs (its Kingdom names, hidden Kingdoms, Full/Discreet/Off levels) are in the
  database (`push_subscriptions`, migration 2). The hub words every push from those prefs, so a Discreet Kingdom's
  pushes carry only `<name> needs you`; the push service sees an encrypted payload either way.
- The hub host needs outbound HTTPS to the browsers' push services (Chrome and Android: `fcm.googleapis.com`). A refused
  push is logged as "a Web Push was refused" and never holds up events; a subscription the service reports gone
  (404/410) is deleted.
- The release that added push applied migration 2, so rolling back past it refuses to start (see Rolling back).

## Kingdom appearance

- Each user's Kingdom icons, banner colours, Belts and tab style are in the database (`appearance`, migration 3), one row
  per tailnet login (`Tailscale-User-Login`, lowercased; `default` when there is none, as in `pnpm dev`). They sync
  across that user's devices: `GET`/`PUT /api/appearance`, last write wins, and the hub sends the change to the
  user's other open tabs at once. Names, hidden Kingdoms and notification levels stay per device, in the browser.
- The release that added it applied migration 3, so rolling back past it refuses to start (see Rolling back). The
  deploy backs the database up before migrating, as for every migration.

## Relayed bytes

- The hub counts the bytes of every frame it sends clients about a session (replay batches, `synced`, live events),
  all devices together, and keeps the counts in memory. It writes them to the `relay` table (migration 4) in one
  transaction every 30 seconds and when it shuts down, never per frame; `GET /api/sessions` adds the unflushed counts
  in, as `relayedBytes`. A crash loses at most the last 30 seconds of counting.
- The release that added it applied migration 4, so rolling back past it refuses to start (see Rolling back).

## Attached files

Files sent with a prompt (the prompt box's +, or a pasted image) travel in the command to the Kingdom, never into the
hub's database: Crystal saves them in a private folder per Quest under the OS temp directory
(`<tmp>/crystal-bridge/attachments/<session>/`, mode 0700, files 0600) and adds an `[Attached file: <path>]` line per
file to the prompt, which is what the hub stores. Every process of the Quest starts with `--add-dir` on that folder, so
the agent reads them without a permission prompt and nothing lands in the project. Limits: 5 files a prompt, about
5 MB each. Closing the Quest removes its folder; folders of Quests that are never closed are empty or small and go
with the OS's own temp cleanup.

## Closed Quests

A closed Quest stays closed: the store ignores its process's later end or resume, and the hub refuses a message, mode or
effort change for one, so a tab left open from before can't run a turn on it. Migration 5 repaired Quests closed before
that fix (marked ended or idle again by their exit); rolling back past it refuses to start, like any migration.

## Monitoring

`GET /api/health` needs no login and returns `{ ok, release, protocol, nodes }`. Point a monitor (for example
Uptime Kuma on the hub host, with `network_mode: host` so it can reach `127.0.0.1`) at `http://127.0.0.1:7700/api/health`:

- the hub: status 200 with `"ok":true`
- each Kingdom: the keyword `"<node-id>"` (for example `"node-a"`), which disappears when that node disconnects

A link can die with no close reaching either end: a proxy in between restarts (Tailscale updating itself on the hub's
host does this to `tailscale serve`), or a machine loses power. So each end pings the other every 30 seconds and drops a
link that was silent for a whole interval. A Kingdom then reconnects by itself within about a minute, resending anything
the hub never acknowledged, and a vanished Kingdom leaves the list as quickly. Each logs it: the Kingdom says "the hub
stopped answering", the hub "a Kingdom stopped answering". Pings are WebSocket control frames, so either side can be
updated first. A Quest keeps running through all of this.

The hub pings browser tabs the same way, and browsers answer by themselves. It drops a tab that stopped answering, and
one that fell more than 32 MiB behind, and either catches up from where it was when it reconnects. A long Quest's replay
may be larger than that, so it gets time to arrive.

Each answer is also when the hub checks a link still has the right to be there: a node token that was rotated or removed
closes its Kingdom's link (code 4007), and a removed login closes its tab (code 4008), both within 30 seconds, which
covers a token changed from a shell, out of the hub's sight. If the token file can't be read at that moment, the link
stays and the next beat tries again.

### Two Crystals on one node id

A cloned VM or a forgotten service can bring a second Crystal with the same node id, and the same token. If the Crystal
already connected answered within the last 45 seconds, the hub keeps it and logs an error, "two Crystals are using this
node id". It believes nothing the newcomer says, so the first one's Quests aren't marked cut off. It holds the newcomer's
connection for 30 seconds and then closes it with code 4009, and the newcomer logs that it was refused and tries again,
so the error repeats about twice a minute until you stop one of them or give it its own node id and token. Holding
matters because every Kingdom, older releases included, redials a second after any close.

A Kingdom coming back after a dead link is let in as before, and at worst waits out one hold: the old link has gone quiet
by then.

## When a write fails

If the hub can't write to its database, say on a full disk, it logs the error and carries on. An event it couldn't store
isn't acknowledged, so the Kingdom keeps it in memory and sends it again the next time it connects. Nothing asks it to
sooner, so after freeing space, restart the hub: Kingdoms reconnect and resend. Restarting a Crystal instead loses them,
because memory is the only place they are. An event the hub can never store, such as a `session.started` with the wrong
shape, is acknowledged and dropped, and the Quest's viewers are told.

## Search

Search reads the hub's database, one Kingdom at a time, the most recently active Quests first and a few thousand events
at a go, so Quests keep running while it looks. It leaves out streaming fragments, whose words are in the full messages. It
stops at 100 matches or after 5 seconds, so on a very long history the oldest Quests can go unsearched.

## Publishing

A public repository starts from a snapshot, not this history: `scripts/publish-snapshot.sh <out-dir> [ref]` writes the
tree of `ref` (default `origin/main`) to a new folder as a repository with one commit under this checkout's repo-local
identity. Old revisions and commit metadata stay behind.

1. On the machine that does the scanning, fetch and run `scripts/publish-snapshot.sh ../crystal-bridge-public`.
2. Scan the snapshot before it goes anywhere: `gitleaks detect --source ../crystal-bridge-public`, `trufflehog
   filesystem ../crystal-bridge-public`, and a grep for your private deny list (host names, tailnet, emails, other
   identities).
3. Push it to a new private repository, check CI and the rendered README, then switch on branch rules, CodeQL, secret
   scanning and Discussions, and make it public.

## The docs site

`docs/` builds into a VitePress site. It's its own pnpm workspace with its own lockfile, so its dependencies never
reach a hub or Kingdom install. `.github/workflows/docs.yml` builds it on every pull request and on `main`. Two checks
catch dead links. VitePress's own build compares each link to the source file names, and `scripts/check-docs-links.mjs`
then checks every internal link and anchor in the built HTML, case-sensitively, as Pages serves it. The second one matters
because page addresses are lower case and file names aren't. Links out of `docs/` work on GitHub, and on the site go to
the same file on GitHub. The logo is a
copy of the app's `favicon.svg`. `scripts/docs-site.test.ts` holds that, and other things a build can't see, such as
every page being in the sidebar.

The workflow publishes only when the repository's **Settings > Pages > Build and deployment > Source** is **GitHub
Actions**. Until then it builds and stops there, on any fork too. It reads the address from that setting, so nothing
names an organisation or a base path. The first publish after turning it on takes a push to `main` or **Run workflow**
on the Docs workflow.
