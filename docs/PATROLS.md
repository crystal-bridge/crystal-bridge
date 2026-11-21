# Patrols

A Patrol sets out from a Kingdom at the hours you give it, does its round and reports back.

::: warning Partly built
Kingdoms run Patrols from their folders, and the app's Watchtower shows them with their runs, creates and edits Quest
Patrols, and runs, pauses, resumes and deletes any Patrol. Patrols post their runs to a Board's Patrol log. A Board's
"Patrol this" isn't built yet. The work is tracked in the
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

A Patrol has exactly one of `quest` and `script`. The exact schema is `PatrolManifest` in
`packages/protocol/src/patrols.ts`, so the Kingdom, the hub and the app check the same thing.

- **`quest`** takes the fields New Quest has: `project`, `prompt` (a file in the Patrol's folder) or `promptText`,
  `mode`, `effort`, `engine` and `worktree`, plus `waitForYou` (see
  [unattended runs](#nobody-watching-unattended-runs)). `prompt` names a file in the Patrol's folder. Unset fields take
  the Kingdom's defaults.
- **`script`** runs `command` in the Patrol's folder as Crystal's user, with the login environment and no node token,
  as a Scout's collector does. It has `timeoutSeconds` (10 minutes unless set) and gets `CRYSTAL_PATROL` (its id) and
  `CRYSTAL_PATROL_RUN` (the run's id). Its exit code, timing and the last 8000 characters of its stdout and stderr go to
  the hub, so keep secrets out of both. Its last line of output is the run's summary, so end with one that says what
  the run came to, such as `2 broken links in docs/INSTALL.md`. When it fails, its last line of stderr is the summary,
  if it wrote one.
- **`catchUp`** and **`board`** sit at the top level, beside `schedule` (see below).

## Keep the watch: schedules

Cron can't say "every other Tuesday", "the last weekday of the month" or "ten times, then stop", so a schedule takes one
of three forms, each with a required IANA time zone:

- **`rule`**: an RFC 5545 recurrence rule, as calendar apps use, with a `start` date-time. `UNTIL` and `COUNT` end it;
  `except` lists dates to skip.
- **`cron`**: five fields, as Scouts use.
- **`once`**: a single date-time. The Patrol stands down after it fires.

Daylight saving follows the time zone, and a night that repeats 01:30 runs it once. On a night that skips 02:30, a
`rule` runs it after the gap (03:30), as calendar apps do, and a `cron` runs it at 03:00, as Scouts always have. The app shows the next few run times before you save, so a rule is checked by eye.

Scouts share this engine, so `scout.json` takes `rule` and `once` too. Existing `cron` schedules work as before. A rule
gives only its parts (`FREQ=...;BYDAY=...`): the start goes in `start` and skipped days in `except`, and `FREQ=SECONDLY`
and `BYSECOND` are refused: the finest a rule runs is each minute. `UNTIL` may be a date or a time in the schedule's
zone, or a UTC time ending in `Z`.

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
latest few runs in memory and sends them when it reconnects; a restart in the meantime loses them. A run that was still
out when Crystal stopped is recorded as `failed` once Crystal is back, without counting towards standing the Patrol down;
a Quest's run says its Quest can be carried on.

## Nobody watching: unattended runs

- A Quest Patrol runs in its `mode`, or the Kingdom's default mode. Like the example Scout Quests, the prompt says what
  the Quest may and may not do.
- A permission prompt notifies as usual and waits up to `waitForYou` (default `30m`; anything past about 24 days waits
  that long). Then the Kingdom denies the prompt, the turn ends, and the run is recorded as `needs-you`. The Quest stays
  open: send it a message to carry on. Only the first turn is timed: after it, the Quest is yours.
- The Quest appears in the Kingdom's list like any other, marked with its Patrol, as a Scout's Quest is marked with its
  item.
- A run's outcome says how the run ended, not whether the work succeeded. Each run also carries a summary, which is
  where the work says whether it worked: the start of the Quest's reply (up to 140 characters, on one line), or a
  script's last line of output (up to 300). So have the prompt ask for a reply that opens with the result, such as
  "Start your reply with what changed, or 'Nothing to do'." With the stream engine, only a turn that ended normally has
  a reply to take; the interactive engine also keeps one from a turn that didn't.
- A run can be marked done once it's back and you've dealt with it. The mark is the hub's own: it works while the
  Kingdom is offline, stays when the Kingdom reports the run again, and goes with the run when it ages out of the
  newest 50.

| Outcome     | Quest Patrol                          | Script Patrol                  |
| ----------- | ------------------------------------- | ------------------------------ |
| `finished`  | the turn ended normally               | exit code 0                    |
| `failed`    | the turn ended in an error or was stopped, or the Quest never started | any other exit code, or it didn't start |
| `timed-out` | not used                              | killed after `timeoutSeconds`  |
| `needs-you` | a permission prompt outwaited `waitForYou` | not used                  |
| `skipped`   | the last run was still out            | the last run was still out     |
| `missed`    | the slot was older than `catchUp`     | the slot was older than `catchUp` |
| `running`   | the run is still out                  | the run is still out           |

## Edit from the app

The Watchtower creates, edits, pauses, resumes and deletes Patrols, and runs one now. The hub sends the change to the
Kingdom, which checks it against `PatrolManifest`, writes `patrol.json` and the prompt file, and answers with the result.
The app never writes anything the Kingdom wouldn't accept from a file.

**New Patrol** (on a wide screen) opens the form. A schedule comes from a preset, the Repeat builder (every so many
minutes, hours, days, weeks or months, from a start, with an end date or a number of runs), a rule's text, cron, or a
single time. As you change it, the form asks the Kingdom for the next five run times and shows them in your time zone,
with the Patrol's zone beside them when it differs; a schedule the Kingdom refuses shows its reason. A Patrol made in the
app keeps its prompt in `patrol.json` as `promptText`, so Edit shows it again. Editing a Patrol whose prompt is a file
keeps the file unless you write a new prompt in the form. Fields the form doesn't show, such as `board` and `except`, are
kept as the file had them.

The app may create and edit **Quest Patrols only**, in the modes New Quest offers, so every action still passes the
Quest's permission mode: a click in the hub never removes approvals. A **script Patrol** runs a command with no approval
at all, so it comes only from a file written on the Kingdom. The app can pause, resume, delete and run one now, but never
create one or change its command.

Deleting a Patrol moves its folder into `.deleted/` inside the patrols folder, named with the time, so a delete from the
app never loses a file someone wrote. A run still out ends as `failed`, saying so: a script is stopped, and a Quest
carries on as an ordinary Quest. A folder that goes away by other means ends its run the same way. When it comes back
it keeps its pause and failure count, and waits for its first time, as a new Patrol does.

The app never saves over a script Patrol, even one whose `patrol.json` doesn't load at the moment: it may save over a
folder only when its `patrol.json` is missing or loads as a Quest Patrol.

`CRYSTAL_PATROLS_FROM_APP=off` goes further for a Kingdom that wants the Scouts' line, where only what's already in a
folder can run: the app can't create or edit any Patrol there, but pause, resume, delete and Run now still work.

A Patrol saved from the app stays on the Kingdom's disk and keeps running after the login that made it is removed. After
removing a login you don't trust, check each Kingdom's Patrols: its patrols folder, or its Castle's
Watchtower. The [security model](SECURITY-MODEL.md) has a
Patrols row.

## Post to a Board

A Patrol can name a Scout's Board on its own Kingdom with `"board": "<scout id>"`. The Board then shows:

- **When each Patrol sets out next**, under the Scout's schedule in the banner, or that it's stood down or can't set
  out.
- **The Patrol log**, beside the list (after Counsel, or after Needs you and Your queue on a projects Board): the
  newest 12 reports from its Patrols. Each says how the run ended and gives its
  [summary](#nobody-watching-unattended-runs), with buttons to open the Quest (or show a script's output), run the
  Patrol again, or mark the report done. Run again waits while that Patrol has a run out, and Done waits for the run to
  be back. A report marked done fades, keeps its way into the Quest, and offers Not done. A run skipped because the
  last was still out isn't reported, since it says nothing new.

The reports are the Patrol's runs, not items in the Scout's list, so the Scout's next collect never removes them. A
Board's Quest action will also offer "Patrol this", which opens the form with the item's prompt filled in.

## Who holds what

- **The Kingdom** holds the Patrol folders, the prompts and scripts, their state, and the scheduler. Credentials stay
  there. It also works out the form's preview of the next run times, so they follow its clock and its time zone data.
- **The hub** stores each Patrol as the Kingdom reported it and a short run history: times, trigger, outcome, reason,
  the end of a script's output, and a link to a Quest's session. Engine output stays in the Quest's event stream; nothing
  engine-specific becomes a column.
- **The browser** shows the Watchtower and the form. The phone shows Patrols read-only for now.

The protocol stays additive: `patrols` and `patrolPreview` flags on `hello`, new frames beside the Scouts' ones, new hub tables in a new
migration, and a `patrol` link on `session.started` for a Patrol's Quest. Older hubs and Kingdoms ignore all of it.

## Not planned

- **Patrols on the hub** that pick a Kingdom when they fire. The Claude login lives on the Kingdom, so Patrols start there;
  hub-side scheduling can come later, with hub Scouts.
- **Triggers from webhooks or events.** As with Scouts, schedules come first.
- **Chains** where one Patrol's outcome starts another.
