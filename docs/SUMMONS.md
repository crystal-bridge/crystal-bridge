# Summons

A **Summon** is a machine you can reach by SSH but don't want to make a Kingdom: a render box, a GPU server, a NAS. A
Quest hands it a job, called a **Cast**, then stops spending tokens on it, and you can still see what's happening.

The problem is ordinary. An agent starts something long on another machine, then has to run commands now and then to
see how it's going. Each check is a model turn, and nothing in the app shows the job. Summons replaces those checks with
plain code that watches for the result.

## What it does and doesn't do

A Cast is just a command. Pipelines are still built on the target, by you or your agent, and Summons wraps whatever is
there. It adds four things SSH doesn't give you: knowing how a job ended, tracking that survives, one place to see jobs,
and taking turns on a machine.

| A machine has | Use |
|---|---|
| an API | An MCP server on the Kingdom. Nothing here is needed. |
| a shell and SSH | A Summon. Nothing is installed on it. |
| Claude Code, and you want Quests there | A Kingdom |

Nothing runs on a Summon between Casts, and there's no worker service. A service would reach fewer machines, because it
needs Node 22 and an install on each one, and it would put a broker on the hub. It's kept as an idea in
[#129](https://github.com/crystal-bridge/crystal-bridge/issues/129) for machines SSH can't reach.

## Setting up

List the machines in the Kingdom's `crystal.env`, then restart Crystal:

```sh
CRYSTAL_SUMMONS=render-box,Shiva=gpu.example.lan/2
```

Each entry is an SSH host name, as `ssh` on the Kingdom knows it. `name=` gives it a name of your own, and `/2` lets it run
two Casts at once. The Kingdom
itself is always there as `here`, with no SSH, except on Windows.

Crystal uses the machine's own `ssh`, with its config, keys and known hosts, and never prompts. So check by hand first,
as the user Crystal runs as:

```sh
ssh -o BatchMode=yes render-box true
```

A key behind a passphrase needs an agent Crystal can reach (`SSH_AUTH_SOCK` from the login environment), since a
service has no terminal. The host must already be in `known_hosts`. A Linux or macOS target needs a POSIX `sh`, `tail`
and `ps`, which they have. A Windows target needs OpenSSH, and uses the PowerShell that comes with Windows.

## How a Cast runs

1. **Start.** The Kingdom connects with the machine's own `ssh`, and pipes a small wrapper and the command over stdin,
   so nothing has to survive shell quoting.
2. **Detach.** The wrapper makes a job folder, starts the command detached and returns straight away. It gets its own
   process group from `setsid`, or `perl` where there's no `setsid`, as on macOS. The command runs under the target user's login shell, so it finds what a
   terminal would.
3. **Follow.** The Kingdom holds one SSH connection open, running `tail -c +<offset> -f` on the log. New lines arrive as
   they're written, so nothing polls. When that connection ends, the far side's `tail` ends with it.
4. **Reconnect.** If the connection drops, the job carries on. The Kingdom reconnects and reads from its last offset.
5. **Cancel.** A second short SSH command stops the job's process group.
6. **Finish.** The wrapper writes the exit code to a temporary file, renames it into place and adds a last line to the
   log. That line wakes the Kingdom, and the `exit` file is the result, so a script can't fake one by printing it.

The job folder is the record, and the target holds it:

```
~/.crystal-bridge/summons/<cast id>/
  command     what was asked for
  pid         the job's process id and group, with its start time
  log         stdout and stderr together
  exit        the exit code, present only once it finished
  cancel      present if a cancel was asked for
```

**A lost job.** If a target reboots, the connection drops, and on reconnecting the Kingdom finds no `exit` and no live
process. It reports the Cast as lost, and doesn't retry it, since only the author knows whether a job can safely run
twice. A wrapper killed while the machine stays up doesn't drop the connection, so the Kingdom also checks the process
every few minutes. That check is plain code and costs no tokens. The start time guards against a reused process id.

A clean shutdown sends the job a signal before the machine goes down, which isn't the job's own failure, so that Cast is
lost too. On Linux the runner sees the system stopping and records no exit. Elsewhere a boot id, saved when the job began,
shows the machine has restarted since a job died by a signal.

**When the Kingdom is off.** A running Cast doesn't need its Kingdom. A closed laptop means you hear about it later. Queued
Casts take their turns on the target, so they don't need it either.

**Self-update.** A Cast doesn't count as a Quest's background work, because it survives a Crystal restart. A Kingdom can
update itself in the middle of one.

## On Windows

The Kingdom tells a Windows target by asking `uname`, once, and uses a PowerShell wrapper with the same job folder and the
same lines, under `%USERPROFILE%`. Nothing is installed there either, and the tool and the panel work the same way. A few
things differ:

- **The command is PowerShell,** so a Quest writes it in that. It runs with no profile loaded, so a tool must be on the
  system or user `PATH`, or be called by its full path: `& "C:\Program Files\Tool\tool.exe"`. Set a tool's exit code with `exit`; a native tool's is passed on by itself.
- **Nobody needs to be signed in.** The job leaves the SSH session's job object, so it survives the session closing. It
  runs without a desktop, in session 0, so a tool that needs one, or a licence tied to a signed-in user, may not work.
  Try the real tool once by hand over SSH first. If a machine's SSH server won't let a job leave, the Cast is reported as
  lost, and its log says why.
- **Cancel** ends a job object holding the command and everything it started.
- **Following** reads the log from a small script on the target, which ends itself every five minutes and is started
  again from the same offset, since it can't tell when a connection has gone.

## Who holds what

- **The target** holds the job folder. The Kingdom removes it a week after the Cast ends.
- **The Kingdom** holds the list of its Summons, the record of its Casts in `~/.crystal-bridge/casts.json`, so a restart
  can find them, and the SSH access. Keys stay here, so separate identities stay separate with no extra work.
- **The hub** stores each Cast's state and the end of its log, shows them and sends notifications. It never connects to
  a target, and the full log stays on the target.

The Castle's **Summoning Circle** lists a Kingdom's Summons and their Casts, running and past, with the end of each log.
It appears once a Kingdom has a Summon or a Cast, and stays off phones for now.

Protocol changes stay additive: new frames beside the existing ones, a `casts` table holding a neutral state, and no
change to a Quest's event stream.

## For agents

A `summon` tool on the Quest's `crystal` MCP server has three actions: start, status and cancel. Its description
explains itself, so an agent can use it unprompted.

| Input | Meaning |
|---|---|
| `action` | `start`, `status` or `cancel` |
| `summon` | which Summon, or `here` for the Kingdom itself |
| `command` | what to run, in the machine's own shell: PowerShell on Windows |
| `onFinish` | `notify` or `wake`, required so the agent chooses each time |
| `name` | optional, what to call this Cast |
| `cwd` | optional, where to run it; otherwise the home folder |
| `cast` | which Cast, for `status` and `cancel` |

The tool works on both engines. Whether a start asks you first follows the Quest's permission mode: in manual it shows
the machine and the command on its approval card, and in auto the CLI can run it without asking.

`notify` tells you and spends nothing. `wake` sends the Quest a message with the result, which costs a turn. Casts
finishing together give one wake-up, and a closed Quest gets a notification instead.

A script can print two kinds of line, in any language. Neither is required, and a script with neither still gets a log
and a result:

```sh
echo '::summon name Video Upscaler'
echo '::summon progress 12/50 episode-12.mkv'
```

A Cast's name comes from the script first, then the tool's `name`, then the command's first word.

`progress` is a count, then an optional label for the item it's on, and it shows as a bar in the Summoning Circle. The
agent adds these where a pipeline already moves from one item to the next:

```python
for number, episode in enumerate(episodes, start=1):
    print(f"::summon progress {number}/{len(episodes)} {episode.name}", flush=True)
    upscale(episode)
```

Flush each line, as Python here, or a buffered script shows them late. A line that isn't in this form stays in the log.

## Taking turns

Each Summon runs one Cast at a time unless its limit is raised (`/2` in `CRYSTAL_SUMMONS`). A Cast that has to wait shows
as waiting, and starts by itself. This happens on the target: a turn is a folder that an atomic `mkdir` claims, under
`~/.crystal-bridge/summons/.slots`, so several Kingdoms can share a machine with no knowledge of each other, and each sees
only its own Casts. A turn left by a killed job or a reboot is taken back. `start` says when a Cast has to wait,
with `queued: true`.

Sharing works when the Kingdoms log in as the same SSH user, because that's whose home the turns are in. Under different
users they don't see each other's turns. Waiting Casts don't always start in the order they were made.

## Security

- A Summon gives the hub's reach one more step: anyone who controls the hub can start Quests, and a Quest can now start
  Casts. A Kingdom only reaches the machines it lists.
- **This is not a sandbox.** A Cast runs as the SSH user with that user's full rights, and "only create new files" is
  the job's promise, not something we enforce.
- A Quest runs as the same user as its Crystal, so it can read the Kingdom's SSH key and use it directly. To really limit
  a Quest, give the Kingdom a restricted key or a limited user on the target.
- Logs can hold secrets. The hub keeps only the end of each one, and it's covered by the same login as Quest history.

## Words

| Crystal theme | Classic | Meaning |
|---|---|---|
| Summon | Machine | a machine reached by SSH, named by you |
| Cast | Job | one job on a Summon |
| Summoning Circle | Machines | the panel on the Castle |

Lines read like a game: "You summoned Shiva!", "Shiva is casting Video Upscaler! 12/50". A Cast then **landed**,
**fizzled** (failed), **was dispelled** (cancelled), or "Shiva vanished!" (lost), each with a plain tooltip.
