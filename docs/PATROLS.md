# Patrols

A Patrol sets out from a Kingdom at the hours you give it, does its round and reports back.

::: warning Planned
This page is the agreed design; none of it is built yet. The work is tracked in the
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
  "name": "Weekly dependency sweep",
  "schedule": {
    "rule": "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
    "start": "2026-12-01T09:00",
    "timezone": "America/Chicago"
  },
  "quest": {
    "project": "~/code/my-app",
    "prompt": "sweep.md",
    "mode": "auto",
    "worktree": true
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
  `mode`, `effort`, `engine` and `worktree`, plus `waitForYou` (below). Unset fields take the Kingdom's defaults.
- **`script`** runs `command` in the Patrol's folder as Crystal's user, with the login environment and no node token,
  as a Scout's collector does. Its exit code, timing and the end of its stdout and stderr go to the hub.

## Keep the watch: schedules

Cron can't say "every other Tuesday", "the last weekday of the month" or "ten times, then stop", so a schedule takes one
of three forms, each with a required IANA time zone:

- **`rule`**: an RFC 5545 recurrence rule, as calendar apps use, with a `start` date-time. `UNTIL` and `COUNT` end it;
  `except` lists dates to skip.
- **`cron`**: five fields, as Scouts use today.
- **`once`**: a single date-time. The Patrol stands down after it fires.

Daylight saving follows the time zone: a 02:30 run on a night that skips 02:30 runs at the next valid time, and a night
that repeats 01:30 runs once. The app shows the next few run times before you save, so a rule is checked by eye.

Scouts move onto the same engine (#281), so `scout.json` gains `rule` and `once`. Existing `cron` schedules keep working
unchanged.

The run rules are the Scouts' ones:

- **A missed run catches up once,** not once per missed slot, and only within `catchUp` (default `6h`, or `never`). A
  laptop that slept through a 03:00 run and opens at 08:00 runs it; one that stayed shut for two days records the run as
  missed.
- **No overlap.** A run due while the last one is still out is skipped and recorded as skipped.
- **A fixed jitter per Patrol,** under half a minute.
- **A new Patrol waits for its first time.** Saving one doesn't run it; Run now does.
- **Three failures in a row stand it down.** Run now still works, and the first success puts it back on schedule.
- **Pause and resume** by hand, kept in the state file beside the patrols folder, like `scouts-state.json`.

A Patrol runs on its Kingdom, so the hub being offline doesn't stop it: the Kingdom holds the runs and sends them when it
reconnects.

## Nobody watching: unattended runs

- A Quest Patrol runs in its `mode`, or the Kingdom's default mode. Like the example Scout Quests, the prompt says what
  the Quest may and may not do.
- A permission prompt notifies as usual and waits up to `waitForYou` (default `30m`). Then the run ends as `needs-you`,
  and its Quest stays open and resumable.
- The Quest appears in the Kingdom's list like any other, marked with its Patrol, as a Scout's Quest is marked with its
  item.
- A run's outcome says how the session ended (`finished`, `failed`, `needs-you`, `timed-out`, `skipped`, `missed`), not
  whether the work succeeded. The run record and the Board item keep that difference visible.

## Edit from the app

The Watchtower creates, edits, pauses, resumes and deletes Patrols, and runs one now. The hub sends the change to the
Kingdom, which checks it against `PatrolManifest`, writes `patrol.json` and the prompt file, and answers with the result.
The app never writes anything the Kingdom wouldn't accept from a file.

This goes further than Scouts, where only what's already in a Scout's folder can run. A Patrol made in the app is a
command or prompt the hub asked for. That's within what hub access already means (a Quest can run anything its mode
allows), but a Kingdom can refuse it: `CRYSTAL_PATROLS_FROM_APP=off` makes the Watchtower read-only there, and Patrols
come only from files.

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
