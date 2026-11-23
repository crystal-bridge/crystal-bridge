# Deeds

A record of what a Kingdom's Quests achieved, day by day, across every project.

::: warning Partly built
The hub and Kingdom parts are built: turn records and tallies, the `deed` tool and the call at Close. The hub keeps turn
records, Deeds and script Patrol runs, fills past turns and serves the feed. The app is planned. The work is tracked in the
[v0.9 Errands and Deeds milestone](https://github.com/crystal-bridge/crystal-bridge/milestone/11) and
[#289](https://github.com/crystal-bridge/crystal-bridge/issues/289).
:::

A **Deed** is a record of work done on a Kingdom. The Castle's Deeds feed lists them newest first, grouped by day,
each one linking back to its Quest. The Chronicle holds the Quests themselves; the Deeds say what they achieved.

Every finished turn leaves a turn record, so nothing is missed. A Quest can also write Deeds, lines in its own words
about what it achieved: during a turn, and once more when you close it. Where a Quest has Deeds, the feed shows those
and folds its turn records beneath them.

## The parts

| Part             | What it is                                                                 | Where it lives         |
| ---------------- | -------------------------------------------------------------------------- | ---------------------- |
| **Turn record**  | one finished turn: when, cost, time, files changed, pull requests opened   | the hub, per Kingdom   |
| **Deed**         | a line or two a Quest wrote about an outcome, during a turn or at Close    | the hub, per Kingdom   |
| **`deed` tool**  | how a Quest writes one during a turn: `mcp__crystal__deed`                 | each Kingdom's Crystal |
| **Closing call** | one short call at Close that writes a Quest's Deeds from a digest of it | each Kingdom's Crystal |
| **Deeds feed**   | the Castle's list of a Kingdom's Deeds and turn records                    | the web app            |

## Keep the tally: turn records

When a turn finishes, the hub writes a turn record from the `turn.finished` event it already stores. No Quest has to
do anything, so a Quest that never closes, or one started before Deeds shipped, still shows its work. A finished turn's
record carries the start of its reply, as one plain line of at most 140 characters (the hub drops control and format
characters such as bidi overrides); a failed or stopped turn has none, and shows its outcome instead.

A turn record also counts what the turn changed: files (Loot) and the pull requests it opened (Trophies). The browser
works these out today, from two sources: the file tools' paths in the raw engine output, and the git diff Crystal
takes after the turn. Crystal sends that diff after `turn.finished`, on purpose, so the event never waits on git and
closing a Quest as a turn ends can't lose it. So the counts come in an event of their own, after the diff:

- `turn.tally` carries the `seq` of the turn's `turn.finished`, `files` (how many files the turn changed) and `prs`
  (the links of the pull requests it opened, at most 10).
- Crystal counts them with the browser's rules for engine output, moved into the protocol package so both share one
  copy, plus the diff's files.
- The hub adds them to the turn record when the tally arrives. A record whose tally never came (an engine that sends
  none, a Kingdom that stopped first) shows no counts, never zeros.

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
records none during its turns. It still gets Deeds at Close, which needs no line.

## Close the chapter: Deeds at Close

**Close** gains a choice, **Record its Deeds**, on by default. Close itself works as today: the Quest stops at once and
is closed, and its worktree is removed if you asked. With the choice on, Crystal then asks for the Quest's Deeds:

1. Crystal builds a digest of the Quest from the CLI's transcript on the Kingdom: its title and project, the files (up
   to 100, each path cut to its last 200 characters) and pull requests (up to 10) its turns tallied, the newest 20
   Deeds and 20 Errands it already left, and for each turn the prompt (up to 500 characters) and the final reply (up
   to 1,500). A digest over 24,000 characters keeps the first turn and the newest ones, and says how many it left out;
   one that still won't fit isn't sent, and the outcome is `unreadable`.
2. Crystal sends the digest to one fresh one-shot `claude` call, the way a Scout's synthesis is made: `-p`,
   `--json-schema` for the answer, `--tools ''` and `--strict-mcp-config` with no MCP servers, so it has no tools at
   all, `--no-session-persistence`, so it leaves no session behind, and `--setting-sources ''`, so no settings load:
   the Kingdom user's `CLAUDE.md`, hooks and plugins can't steer it. It doesn't resume the Quest, and it runs from a
   fresh empty folder under Crystal's own `~/.crystal-bridge/closing`, removed afterwards. Calls at Close run one at
   a time: closing several Quests at once queues them, and stopping Crystal drops the ones still waiting.
3. The prompt marks the digest as data, not instructions, and asks for 1 to 5 Deeds covering the whole Quest, one per
   outcome that matters, without repeating the Deeds already left. The answer is JSON in the `deed` tool's shape.
4. Crystal sends each Deed as a `deed.recorded` event marked `closing`, then a `deeds.closing` event with the outcome
   and cost.

The call can't edit a file, run a command or reach another machine, in any mode. It has 2 minutes. A Kingdom can set
`CRYSTAL_CLOSING_MODEL`, passed as `--model`, to use a cheaper model than the account's default.

**What it costs.** The call reads the digest, not the Quest's whole context, so its cost depends on the digest's size,
not the Quest's length. On 2026-11-22, with CLI 2.1.330, the recorded calls for small digests (340 to 841 characters,
1 to 2 turns) cost $0.024 to $0.035 each and took 2 to 3 seconds
([recorded](https://github.com/crystal-bridge/crystal-bridge/blob/main/apps/crystal/test/fixtures/README.md#the-call-at-close-closingndjson-closing-interactivendjson-cli-21330)).
An earlier probe, before `--setting-sources ''` was added, cost about $0.09 for a 25,000-character digest, the cap's
size; a full digest costs more than a small one. `CRYSTAL_CLOSING_BUDGET_USD` ($1 by default) passes `--max-budget-usd` as a backstop. The
CLI checks it only after the call, so a call over it is billed in full and its answer thrown away; the digest cap is
what keeps the cost down. The Close dialog says beside the choice: *"Writes the Quest's Deeds from a short digest of
it, for a few cents."* The choice is kept per device.

**In the chat**, a closed Quest ends with one line in the theme's voice: *"Your Quest's Deeds are recorded in the
annals of the Kingdom."*, then the Deeds. Or, when there are none, why: *"No Deeds recorded: the call took too long."*
The Classic theme says *"Summary recorded."* The call raises no notification, since it isn't a turn.

**When it's skipped.** The Quest closes with no call when you turn the choice off, when the Quest has no finished turn
since its last Deeds at Close, or when its Kingdom is too old to offer it; the dialog shows the choice greyed, with the
reason. Close needs the Kingdom online, as it does today. A Patrol's Quest is closed only by you, so the same choice
applies. If the transcript can't be read, or the call fails, runs out of time or budget, or writes nothing, the Quest
stays closed, its turn records stay as they were, and the chat and the feed say which.

## Read the annals: the Deeds feed

**On the Castle**, the Deeds feed lists a Kingdom's work newest first, grouped by day in your own time zone (Today,
Yesterday, then dates). A chip per project filters it, each project in its own colour, as on the Errands panel. It
uses gold for Deeds and never window blue, since nothing in it waits on you. It sits in the Castle's left column,
under Active Quests, as a timeline: a gold rail down the side with a marker for each day and one row per Quest's
day, its icon on the rail. On a narrower screen it follows the Castle's other panels.

Within a day, each Quest's records fold into one entry, so a run of short turns ("yes, go on") reads as one line:

- **A Quest with Deeds** shows them as its lines, a Deed from Close marked apart from one from a turn. The day's turn
  records fold beneath, as one line of totals.
- **A Quest with only turn records** shows one line, headed by the Quest's title, with the day's totals: _"The Siege
  of the Flaky Smoke Test · 3 turns · 12 files · PR #319 · $1.84 · 42m"_, and the start of the latest reply beneath it
  in a lighter tone. It unfolds to the turn records. A Quest that never named itself shows the first words of its
  prompt, as its tab does.

Each entry marks its Quest with an icon: open, closed with Deeds, or closed without them, the last saying why
(skipped, too long, over budget, nothing written). Each links to its Quest; a link to a closed Quest opens it as the
Chronicle does. A Patrol's Quest shows its Patrol's icon. A script Patrol's finished or failed run is an entry of its
own with the run's summary line, the same line the Patrol log shows; skipped and missed runs aren't Deeds.

A Quest that runs over several days has an entry on each day it worked; its Deeds from Close land on the day it
closed, beside any it wrote in turns, which stay. The call's cost counts on that day's totals, not as a turn. A
script Patrol's entry links to its run in the Patrol log, since it has no Quest.

The feed loads older days as you scroll. With no records yet, it says so in one line; if it couldn't be read, it says
why. In a Quest, the side panel shows that Quest's Deeds.

The Classic theme calls a Deed an Outcome and the feed a Work log, since Recent activity is the Adventure log's.

**On a phone,** the feed is read-only: the same entries, chips and links, with the totals line and no unfolding.

**Notifications and Discreet.** Deeds raise no notifications. On a Discreet Kingdom (#93), Deed text follows the
Kingdom's Discreet setting wherever titles do.

## Keep the scrolls: on the hub

The hub writes a `deeds` row for each turn record, each Deed, each call at Close and each script Patrol run, in a new migration. The
event or run report is stored first, so a malformed one writes no row and is never refused for it.

| Column                                    | Holds                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `id`                                      | `turn:<session>:<seq>`, `deed:<uuid>`, `run:<run id>` or `close:<session>:<seq>` |
| `node`                                    | its Kingdom; the primary key is `(node, id)`                             |
| `session`, `seq`                          | the Quest and the event that made it; empty for a script Patrol's run    |
| `patrol`                                  | the Patrol, for a Patrol's Quest or run                                  |
| `project`                                 | the project folder                                                       |
| `kind`                                    | `turn`, `deed`, `closing` (a Deed from Close), `close` (how the call at Close went: its outcome, cost and reason) or `patrol` (a script run) |
| `text`, `detail`                          | a Deed's line and detail, a turn's reply start, a call's reason, or a run's summary     |
| `outcome`                                 | a turn's or run's outcome                                                |
| `cost_usd`, `duration_ms`, `files`, `prs` | a turn's numbers; empty when not reported                                |
| `at`                                      | when it happened                                                         |

A prefixed id per kind keeps the four sources apart, and the hub's own `(session, seq)` key on events already drops a
resent event before any row is made. A Kingdom picks its Deed and run ids, so the key includes the Kingdom: one
Kingdom reporting another's id writes its own row and never touches the other's. Turn and Deed rows are written once; a tally fills its turn's counts later. A
script Patrol's row is upserted from the run report, which comes twice under one id (out, then back), and written only
once the run is back, finished or failed; like `patrol_runs`, it keeps the Patrol it was first reported under.

The feed reads by Kingdom and time, and by Kingdom, project and time, and each has an index. Clients read it over HTTP,
a page of days at a time, and get new rows as an additive `deeds` frame. A page holds at most 5,000 rows; a full one
says where it stopped (`more`), and the client asks for the rest of the same days from there before moving on to
older days.

**History.** After the migration, the hub fills turn records for the turns it already holds, once, from the stored
`turn.finished` events. It runs in code on the first start, not in the migration's SQL, because a Quest's project
comes from its `session.started` event and older worktree Quests need the same path rule Errands use. Those older
records have no counts, since older Kingdoms sent no tally, and no Patrol link beyond what `patrol_runs` still keeps.

**Keep.** Deeds are a record, so the hub keeps them until you forget the Kingdom, which deletes them and sends
clients a `deeds` frame marked `cleared`, so they drop that Kingdom's rows too. A turn record is
a small row: a Kingdom running a few hundred turns a day adds roughly 30 MB a year, an estimate, not a measurement.
Deleting a Quest by hand (see [What Crystal Bridge stores](HUB-DATA.md)) deletes its rows by `session`.

## Weigh the words: trust

A Deed's text is written by the Quest, and a Quest reads untrusted text. A Deed is plain text in the feed: no Markdown,
links or HTML, so a prompt injection can at most write a misleading line. The digest at Close carries text the Quest read,
so the call marks it as data, and it has no tools and no MCP servers: a Close can't be turned into work you didn't ask
for.

## Who holds what

- **The Kingdom** offers the tool, tallies each turn's files and pull requests, and makes the call at Close. It stores
  nothing.
- **The hub** stores the events and the `deeds` table. Nothing engine-specific becomes a column.
- **The browser** shows the feed and folds it by Quest and day.

The protocol stays additive: `turn.tally`, `deed.recorded` and `deeds.closing` events, a `deeds` option on
`session.close`, a hello flag for Kingdoms that make the call, a `deeds` frame, a new table in a new migration, and
HTTP routes. Older Kingdoms send no tally and close with no call. Update the hub before the Kingdoms, as
[Operations](OPERATIONS.md) says for any new event.

## Prove it first

A probe on 2026-11-22 showed why the call takes a digest. With `--resume`, the same flags worked (the answer came back
and the transcript was unchanged), but the call missed the prompt cache and paid for the whole context, and a call
over `--max-budget-usd` was billed in full with its answer thrown away. A fresh call with a 25,000-character digest
came back in shape for about $0.09. The build starts by recording the digest call from both engines' transcripts; if
it doesn't hold, the design comes back here before anything else is built.

## Not planned

- **Writing or editing a Deed by hand.** A Deed is what a Quest did. Your own notes belong in an Errand.
- **A feed across Kingdoms.** Kingdoms first, as with Scouts, Patrols and Errands.
