# Patrols

A Patrol sets out from a Kingdom at the hours you give it, does its round and reports back.

::: warning Planned
This page is the agreed design. The hub stores the Patrols a Kingdom reports and their runs, and passes on changes
from the app; Kingdoms don't run Patrols yet, and the app doesn't show them. The work is tracked in the
[v0.8 Patrols milestone](https://github.com/crystal-bridge/crystal-bridge/milestone/10) and #278.
:::

A **Patrol** is a scheduled job on a Kingdom. It runs either a Quest from a saved prompt, or a script of yours, at times
set by a recurrence rule. Every run is recorded, and a Patrol can post its runs to a Board.

Scouts and Patrols divide the work: Scouts look, Patrols act. A Scout collects a list and never acts without you
([Scouts and Boards](SCOUTS.md)). A Patrol acts on its schedule, with nobody watching, so its prompt carries the safety.

## The parts

| Part       | What it is                                                                        | Where it lives                       |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| **Patrol** | a schedule and either a Quest (prompt, folder, mode) or a script (command, timeout) | a folder on the Kingdom              |
| **Run**    | one time a Patrol set out, or was due and skipped, with its outcome               | the hub, a short history per Patrol  |
| **Watchtower** | the Castle panel that lists a Kingdom's Patrols, their next runs and history | the web app                          |

A Patrol runs as its Kingdom's identity: its Claude plan, its `gh` login, its files. Nothing from one Kingdom reaches
another.

## Lay out the route: a Patrol's folder

Each Patrol is a folder under `~/.crystal-bridge/patrols/` on the Kingdom, beside `scouts/` (`CRYSTAL_PATROLS_DIR` moves
it). The folder name is the Patrol's id: lowercase letters, digits and dashes. Crystal reads the folder again on change,
so editing needs no restart, and a `patrol.json` that doesn't load keeps its last good version and shows the error in the
Watchtower.

Files come first, so any harness, editor or Quest can write a Patrol. The app's form writes the same file (see
[Edit from the app](#edit-from-the-app)).

A Quest Patrol:

```json
{
  "name": "Fortnightly dependency sweep",
  "schedule": {
    "rule": "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
    "start": "2026-12-01T09:00",
    "timezone": "America/Chicago"
  },
  "catchUp": "6h",
  "quest": {
    "project": "~/code/my-app",
    "prompt": "sweep.md",
    "mode": "auto",
    "worktree": true,
    "waitForYou": "30m"
  }
}
```

A script Patrol:

```json
{
  "name": "Nightly backup check",
  "schedule": { "cron": "30 3 * * *", "timezone": "Europe/Berlin" },
  "script": { "command": ["./check.sh"], "timeoutSeconds": 600 }
}
```

A Patrol has exactly one of `quest` and `script`. The exact schema will be `PatrolManifest` in
`packages/protocol/src/patrols.ts`, so the Kingdom, the hub and the app check the same thing.

- **`quest`** takes the fields New Quest has: `project`, `prompt` (a file in the Patrol's folder) or `promptText`,
  `mode`, `effort`, `engine` and `worktree`, plus `waitForYou` (see
  [unattended runs](#nobody-watching-unattended-runs)). `prompt` names a file in the Patrol's folder. Unset fields take
  the Kingdom's defaults.
- **`script`** runs `command` in the Patrol's folder as Crystal's user, with the login environment and no node token,
  as a Scout's collector does. Its exit code, timing and the end of its stdout and stderr go to the hub.
- **`catchUp`** and **`board`** sit at the top level, beside `schedule` (see below).

## Keep the watch: schedules

Cron can't say "every other Tuesday", "the last weekday of the month" or "ten times, then stop", so a schedule takes one
of three forms, each with a required IANA time zone:

- **`rule`**: an RFC 5545 recurrence rule, as calendar apps use, with a `start` date-time. `UNTIL` and `COUNT` end it;
  `except` lists dates to skip.
- **`cron`**: five fields, as Scouts use.
- **`once`**: a single date-time. The Patrol stands down after it fires.

Daylight saving follows the time zone: a 02:30 run on a night that skips 02:30 runs at the next valid time, and a night
that repeats 01:30 runs once. The app shows the next few run times before you save, so a rule is checked by eye.

Scouts move onto the same engine (#281), so `scout.json` gains `rule` and `once`. Existing `cron` schedules keep working
unchanged.

These run rules are the Scouts' ones:

- **No overlap.** A run due while the last one is still out is skipped and recorded as skipped. A Quest Patrol's run is
  out until its Quest's turn ends.
- **A fixed jitter per Patrol,** under half a minute.
- **A new Patrol waits for its first time.** Saving one doesn't run it; Run now does.
- **Three failures in a row stand it down.** `failed` and `timed-out` count as failures; `finished` counts as a
  success, and `needs-you`, `skipped` and `missed` count as neither. Run now still works, and the first success puts it
  back on schedule.

Two are new with Patrols:

- **A missed run catches up once, within a window.** Scouts run one catch-up however late. A Patrol acts, so a run that
  turns up long after its time may do harm: it catches up only within `catchUp` (default `6h`, or `never`) and records
  an older slot as `missed`. A laptop that slept through a 03:00 run and opens at 08:00 runs it; one that stayed shut for
  two days records it as missed. Run now still runs it by hand.
- **Pause and resume by hand,** kept in the state file beside the patrols folder, like `scouts-state.json`.

Scouts keep their own rules when they move onto the shared engine: no catch-up window and no manual pause unless a later
issue adds them.

A Patrol runs on its Kingdom, so the hub being offline doesn't stop it. As with Scouts, the Kingdom holds each Patrol's
latest few runs in memory and sends them when it reconnects; a restart in the meantime loses them.

## Nobody watching: unattended runs

- A Quest Patrol runs in its `mode`, or the Kingdom's default mode. Like the example Scout Quests, the prompt says what
  the Quest may and may not do.
- A permission prompt notifies as usual and waits up to `waitForYou` (default `30m`). Then the Kingdom denies the
  prompt, the turn ends, and the run is recorded as `needs-you`. The Quest stays open: send it a message to carry on.
- The Quest appears in the Kingdom's list like any other, marked with its Patrol, as a Scout's Quest is marked with its
  item.
- A run's outcome says how the run ended, not whether the work succeeded. The run record and the Board item keep that
  difference visible.

| Outcome     | Quest Patrol                          | Script Patrol                  |
| ----------- | ------------------------------------- | ------------------------------ |
| `finished`  | the turn ended normally               | exit code 0                    |
| `failed`    | the turn ended in an error            | any other exit code            |
| `timed-out` | not used                              | killed after `timeoutSeconds`  |
| `needs-you` | a permission prompt outwaited `waitForYou` | not used                  |
| `skipped`   | the last run was still out            | the last run was still out     |
| `missed`    | the slot was older than `catchUp`     | the slot was older than `catchUp` |
| `running`   | the run is still out                  | the run is still out           |

## Edit from the app

The Watchtower creates, edits, pauses, resumes and deletes Patrols, and runs one now. The hub sends the change to the
Kingdom, which checks it against `PatrolManifest`, writes `patrol.json` and the prompt file, and answers with the result.
The app never writes anything the Kingdom wouldn't accept from a file.

The app may create and edit **Quest Patrols only**, in the modes New Quest offers, so every action still passes the
Quest's permission mode: a click in the hub never removes approvals. A **script Patrol** runs a command with no approval
at all, so it comes only from a file written on the Kingdom. The app can pause, resume, delete and run one now, but never
create one or change its command.

`CRYSTAL_PATROLS_FROM_APP=off` goes further for a Kingdom that wants the Scouts' line, where only what's already in a
folder can run: the app can't create or edit any Patrol there, but pause, resume, delete and Run now still work.

A Patrol saved from the app stays on the Kingdom's disk and keeps running after the login that made it is removed. After
removing a login you don't trust, check each Kingdom's Watchtower. The [security model](SECURITY-MODEL.md) gains a
Patrols row with the build.

## Post to a Board

A Patrol can name a Scout's Board with `"board": "<scout id>"`. Each run posts an item with its outcome, a one-line
summary and buttons to open the Quest, run again or mark done. A Patrol's items are kept apart from the Scout's own list,
so the Scout's next collect doesn't remove them. A Board also shows its Patrols' next run times, and a Board's Quest
action can offer "Patrol this", which opens the form with the item's prompt filled in.

## Who holds what

- **The Kingdom** holds the Patrol folders, the prompts and scripts, their state, and the scheduler. Credentials stay
  there.
- **The hub** stores each Patrol as the Kingdom reported it and a short run history: times, trigger, outcome, reason,
  the end of a script's output, and a link to a Quest's session. Engine output stays in the Quest's event stream; nothing
  engine-specific becomes a column.
- **The browser** shows the Watchtower and the form. The phone shows Patrols read-only for now.

The protocol stays additive: a `patrols` flag on `hello`, new frames beside the Scouts' ones, new hub tables in a new
migration, and a `patrol` link on `session.started` for a Patrol's Quest. Older hubs and Kingdoms ignore all of it.

## Not planned

- **Patrols on the hub** that pick a Kingdom when they fire. The Claude login lives on the Kingdom, so Patrols start there;
  hub-side scheduling can come later, with hub Scouts.
- **Triggers from webhooks or events.** As with Scouts, schedules come first.
- **Chains** where one Patrol's outcome starts another.
