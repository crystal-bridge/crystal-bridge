# Deeds

The annals of a Kingdom: what its Quests achieved, day by day, across every project.

::: warning Planned
This page is the proposed design; none of it is built yet. The work is tracked in the
[v0.9 Errands and Deeds milestone](https://github.com/crystal-bridge/crystal-bridge/milestone/11) and #289.
:::

A **Deed** is a record of work done on a Kingdom. The Castle's Deeds feed lists them newest first, grouped by day,
each one linking back to its Quest. The Chronicle holds the Quests themselves; the Deeds say what they achieved.

Every finished turn records one, so nothing is missed. A Quest you close properly also curates its own: it writes
a few lines that sum up the whole Quest, and those take the place of its turn records in the feed.

## The parts

| Part              | What it is                                                                   | Where it lives         |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------- |
| **Turn record**   | one finished turn: when, cost, time, files changed, pull requests opened     | the hub, per Kingdom   |
| **Deed**          | a line or two a Quest wrote about an outcome, during a turn or as it closed  | the hub, per Kingdom   |
| **`deed` tool**   | how a Quest writes one: `mcp__crystal__deed` on Crystal's MCP server         | each Kingdom's Crystal |
| **Closing turn**  | one short last turn, on Close, in which the Quest writes its Deeds          | each Kingdom's Crystal |
| **Deeds feed**    | the Castle's list of a Kingdom's Deeds and turn records                      | the web app            |

## Keep the tally: turn records

When a turn finishes, the hub writes a turn record from the `turn.finished` event it already stores. No Quest has to
do anything, so a Quest that never closes, or one started before Deeds shipped, still shows its work.

A turn record holds what the turn did, in numbers: its cost and time, how many files it changed (Loot) and the pull
requests it opened (Trophies), and the start of its reply. The browser works out Loot and Trophies today, from the
raw engine output. For the hub to keep them without reading engine output, Crystal adds two optional fields to
`turn.finished`:

- `files`: how many files the turn changed.
- `prs`: the links of the pull requests it opened, at most 10.

Crystal counts them with the rules the browser uses, moved into the protocol package so both share one copy. An
engine without them leaves both out, and the record shows no count.

## Sing of it: the `deed` tool

Crystal's MCP server, which every Quest already has for approvals, its title and Errands, gains a tool:

```json
{ "deed": "Moved the hub to Node 24", "detail": "Dropped the polyfill; the image is 30 MB smaller." }
```

- `deed` is one line of plain text, up to 120 characters, checked as a Quest title is.
- `detail` is optional plain text, up to 280 characters. It isn't Markdown, so it carries no links.

A Deed's project is the Quest's project folder, the repository's folder for a Quest in a worktree, as with Errands.
Crystal allows the tool on both engines, as it does `title` and `errand`, so a call never raises a permission card.

Crystal's appended system prompt gains one line: when a turn achieves something worth remembering (a release, a
migration, a fix that closes an issue), load `mcp__crystal__deed` and record it in a line. Routine steps aren't Deeds.
A Quest may record at most 3 Deeds in one turn; past that, the tool refuses with the reason. As with Errands, the line
rides in the one `--append-system-prompt` value a Quest's first process gets, so a Quest started before Deeds shipped
records none during its turns. It can still curate its Deeds at Close, because the closing prompt names the tool.

## Close the chapter: the closing turn

**Close** gains a choice, **Record its Deeds**, on by default. With it on, Crystal gives the Quest one last turn before
it stops the process:

1. Crystal sends a fixed prompt: sum up this whole Quest in 1 to 5 Deeds with `mcp__crystal__deed`, one per outcome
   that matters, then stop. It names what the Quest already recorded, so the Quest doesn't repeat them.
2. The closing turn can use Crystal's `deed` tool and nothing else. A Quest's built-in tools are off for that turn,
   so a closing turn can't edit a file or run a command, in any mode.
3. When the turn ends, or after 2 minutes, Crystal closes the Quest as Close does today: it stops the process,
   removes the worktree if you asked, and records `session.closed`.

The chat shows the closing turn as *"Your Quest records its Deeds in the annals of the Kingdom."*, then the Deeds it
wrote. Its cost counts toward
the Quest's cost like any turn.

**What it costs.** The closing turn resumes the Quest with its whole context. Soon after the last turn, the prompt
cache usually still holds that context and the turn is cheap. Hours later, the cache has expired and the turn pays
for the full context again, which on a long Quest can cost more than a short turn. The Close dialog says so, and
remembers the choice per device.

**When it's skipped.** The Quest closes without a closing turn when you turn the choice off, when the Quest has no
finished turn since it last curated, when a turn is still running (Close stops it, as today), when the Kingdom is too
old to offer it, or when the Quest's Kingdom is offline and the hub closes it on the Kingdom's return. If the closing
turn fails, times out or writes nothing, the Quest still closes and its turn records stay as they were.

## Read the annals: the Deeds feed

**On the Castle**, the Deeds feed lists a Kingdom's work newest first, grouped by day in your own time zone (Today,
Yesterday, then dates). A chip per project filters it, each project in its own colour, as on the Errands panel.

Within a day, each Quest's records fold into one entry, so a run of short turns ("yes, go on") reads as one line:

- **A Quest with Deeds** shows them as its lines: those it wrote during turns and, once closed, those from its closing
  turn. The day's turn records fold beneath, as a line of totals.
- **A Quest with only turn records** shows one line, headed by the Quest's title, with the day's totals: *"The Siege
  of the Flaky Smoke Test · 3 turns · 12 files · PR #319 · $1.84 · 42m"*, and the start of the latest reply beneath
  it in a lighter tone. It unfolds to the turn records.

Each entry marks its Quest as open, closed with Deeds, or closed without them, and links to it. A link to a closed
Quest opens it as the Chronicle does. A Patrol's Quest shows its Patrol's icon; a script Patrol's run is an entry of
its own, with the run's summary line. The feed loads older days as you scroll.

The layout comes from an audition. The Classic theme says Work log, since Recent activity is the Adventure log's.

**On a phone,** the feed is read-only, with no unfolding of turn records.

Deeds raise no notifications. Nothing in the feed waits on you.

## Keep the scrolls: on the hub

The hub writes a `deeds` row for each turn record, each Deed and each script Patrol run, in a new migration. Rows
come from events it already stores, so a repeated or malformed event writes nothing and never refuses the event
itself.

| Column           | Holds                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| `id`             | the row's id: the Deed's UUID from Crystal, or derived from the event or Patrol run   |
| `node`           | its Kingdom                                                                           |
| `session`, `seq` | the Quest and the event that made it; empty for a script Patrol's run                 |
| `patrol`         | the Patrol, for a Patrol's Quest or run                                               |
| `project`        | the project folder                                                                    |
| `kind`           | `turn`, `deed`, `closing` (a Deed from a closing turn) or `patrol` (a script run)     |
| `text`, `detail` | a Deed's line and detail, or the start of a turn's reply                              |
| `cost_usd`, `duration_ms`, `files`, `prs` | a turn's numbers; empty when the engine didn't report them   |
| `at`             | when it happened                                                                      |

`turn` and `deed` rows are keyed by Kingdom, Quest and `seq`, so a resent event never doubles a row. The feed reads
by Kingdom and time, and by Kingdom, project and time, and each has an index. Clients read the feed over HTTP, a page
of days at a time, and get new rows as an additive `deeds` frame.

**History.** The migration fills turn records for every turn the hub already holds, from the stored `turn.finished`
events, so the feed opens with your past work rather than empty. Those older records have no file or pull request
counts, since older events didn't carry them.

**Keep.** Deeds are a record, so the hub keeps them until you forget the Kingdom, which deletes them. A turn record is
a small row: a Kingdom running a few hundred turns a day adds a few megabytes a year. Deleting a Quest by hand (see
[What Crystal Bridge stores](HUB-DATA.md)) deletes its rows by `session`.

## Weigh the words: trust

A Deed's text is written by the Quest, and a Quest reads untrusted text. A Deed is plain text in the feed: no
Markdown, links or HTML, so a prompt injection can at most write a misleading line. The closing turn has no tools but
`deed`, so a Close can't be turned into work you didn't ask for.

## Who holds what

- **The Kingdom** offers the tool, counts each turn's files and pull requests, and runs the closing turn. It stores
  nothing.
- **The hub** stores the events and the `deeds` table. Nothing engine-specific becomes a column.
- **The browser** shows the feed and folds it by Quest and day.

The protocol stays additive: two optional fields on `turn.finished`, a `deed.recorded` event, a `deeds` option on
`session.close`, a hello flag for Kingdoms that offer the closing turn, a `deeds` frame, a new table in a new
migration, and HTTP routes. Older Kingdoms send turns without counts and close without a closing turn. Update the hub
before the Kingdoms, as [Operations](OPERATIONS.md) says for any new event.

## Not planned

- **Writing or editing a Deed by hand.** A Deed is what a Quest did. Your own notes belong in an Errand or, later, the
  Library.
- **A feed across Kingdoms.** Kingdoms first, as with Scouts, Patrols and Errands.
