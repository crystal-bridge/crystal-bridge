# Scouts and Boards

A Scout rides out on a schedule, comes back with what it found, and posts it on a Board for you to act on.

::: warning Partly built
This page is the agreed design. A Kingdom finds and runs Scouts on their schedules, the hub stores what they
find, the app shows each Scout's Board with a button for every action, and the synthesis step ranks and sums up the
list. Scouts that run on the hub aren't built yet. The work is tracked in the
[v0.7 Scouts milestone](https://github.com/crystal-bridge/crystal-bridge/milestone/9).
:::

A **Scout** is a job you define on a Kingdom. It runs a script of yours on a schedule, the script prints what it found as
a list of items, and the app shows them on a **Board**: a tab of its own, with a button for each thing you can do about
an item. One of those buttons can start a Quest with the item already in its prompt.

Two uses shaped it:

- **A Quest Board for your repositories.** Your open pull requests and their checks, pull requests from others waiting
  on you, your issues across repositories, and forum topics about your projects. Each item offers the Quest that acts
  on it: fix the failing check, answer the review, triage the issue.
- **A personal mail Board.** New mail sorted into what to archive, what looks like spam, what needs a reply and what
  needs a follow-up somewhere else, such as paying a card. A pattern that a Gmail filter would handle comes up as a
  suggestion of its own.

## The idea: scripts collect, the model judges

Collecting is plain code. Calling GitHub or Gmail, comparing with the last run and noticing that nothing changed costs no
tokens and gives the same answer every time. A model is only worth its cost where judgement is needed: ranking, a
one-line summary, picking which action fits.

So a Scout has up to three steps, and only the first is required:

1. **Collect.** Your script prints a JSON list of items. No model is involved.
2. **Synthesize** (optional). When the list changed, the Kingdom asks `claude` to rank the items, summarize them and
   suggest an action for each, choosing only from the actions the Scout declares.
3. **Act.** You press a button. The action is a Quest, a script of yours, a link, or a change of state such as done.

A Scout never acts by itself. A suggestion is a highlighted button, and you press it.

## The parts

| Part | What it is | Where it lives |
|---|---|---|
| **Scout** | a schedule, a collector script, an optional synthesis prompt and a list of actions | a folder on the Kingdom |
| **Board** | the tab that shows a Scout's items | the web app: a pinned tab in that Kingdom's tab strip, and its Castle |
| **Item** | one thing the Scout found, with a stable id | sent by the Kingdom, stored by the hub |
| **Run** | one execution of a Scout, with its outcome and cost | the hub, a short history per Scout |

A Kingdom is a machine together with the accounts signed in there, so a Scout runs as that identity: its `gh` login,
its Google token, its Claude plan. A work Kingdom and a personal Kingdom each keep their own Boards, and nothing from
one reaches the other.

## Lay out the camp: a Scout's folder

Each Scout is a folder under `~/.crystal-bridge/scouts/` on the Kingdom (`%USERPROFILE%\.crystal-bridge\scouts\` on
Windows; `CRYSTAL_SCOUTS_DIR` moves it). Crystal reads the folder again every few seconds, so adding or editing a Scout
needs no restart. A folder name must be lowercase letters, digits and dashes, since it's the Scout's id; other folders
are left alone. A Scout whose `scout.json` doesn't load keeps its last good version and shows the error on its Board.

```
~/.crystal-bridge/scouts/quest-board/
  scout.json        the definition
  collect.sh        prints the items
  synthesize.md     the prompt for the optional synthesis step
  fix.md            a prompt template for a Quest action
  act.sh            runs script actions
  state/            the Scout's own state, such as a saved cursor; Crystal never reads it
```

Files first, so any harness, any editor or a Quest can write a Scout. An editor in the app may come later.

This is an example `scout.json`. The exact schema is `ScoutManifest` in `packages/protocol/src/scouts.ts`, so the Kingdom
and the hub check the same thing:

```json
{
  "name": "Quest Board",
  "icon": "pull-request",
  "schedule": { "cron": "*/15 8-20 * * 1-5", "timezone": "America/Chicago" },
  "collect": { "command": ["./collect.sh"], "timeoutSeconds": 120 },
  "synthesize": { "prompt": "synthesize.md", "when": "changed" },
  "view": "list",
  "summary": [{ "label": "Failing checks", "field": "checks" }],
  "show": { "who": "author", "when": "updated" },
  "actions": {
    "fix": {
      "kind": "quest",
      "label": "Fix it",
      "project": "{{fields.checkout}}",
      "prompt": "fix.md",
      "mode": "auto",
      "worktree": true
    },
    "open": { "kind": "link", "label": "Open", "url": "{{url}}" },
    "snooze": { "kind": "snooze", "label": "Later", "for": "1d" },
    "done": { "kind": "done", "label": "Done" }
  }
}
```

`summary` and `show` only shape the Board. `summary` is up to six counts for its banner, each counting the open items
whose `field` is set to anything but `false`, `0` or empty. `show` names the fields a `list` row draws as a mail list
does: `who`, `when` (an ISO date or a count of seconds or milliseconds), `unread` and `preview`. `whoKey` names a field
that identifies the sender for good, such as an address: each sender gets a colour of its own, the same on every visit,
keyed on that field, or on the name shown without it. A malformed `summary`,
`show` or `icon` is dropped, never failing the Scout.

A `summary` entry may also name an `icon` and a `tone`, which its banner tile wears; the built-in tiles have their own.
The names are the Board mark icons and tones in [the theme](./THEME.md#inventory).

`view` is `list`, `checklist`, `table` or `projects`. The `projects` view groups items by project and draws each row
from its `fields`, so the manifest says how, in a `projects` block. `kind` picks the row's icon, `marks` (up to four)
add status icons, and `reasons` say why an item needs you. Each is a `field` and, per value, an `icon`, a `tone` and a
`label`. The slots `who`, `whoKey`, `when`, `comments`, `added`, `removed` and `mine` name fields too. A malformed block
is dropped, and the Board falls back to the mail-style list.

A reason value may also say `"lane": "queue"`: its items go to the queue window, for your own work in order, instead of
Needs you, which is for work someone is waiting on. `"lane": "needs"` is the default. An optional `queue` block gives
that window a `title` (default "Your queue") and names the fields it orders by: `priority`, a number, lowest first, and
`due`, a date, soonest first; after those, the oldest comes first. A lane this hub doesn't know is dropped, and so is a
malformed `queue` block, each alone, so those items show in Needs you, as they do on an older hub.

```json
{
  "view": "projects",
  "projects": {
    "kind": {
      "field": "type",
      "values": {
        "pr": { "icon": "pull-request", "tone": "emerald", "label": "Pull request" },
        "issue": { "icon": "issue", "tone": "violet", "label": "Issue" }
      }
    },
    "marks": [
      {
        "field": "checks",
        "values": { "failing": { "icon": "x-circle", "tone": "red", "label": "Checks failing" } }
      }
    ],
    "reasons": {
      "field": "reason",
      "values": {
        "review": { "icon": "eye", "tone": "blue", "label": "Review asked" },
        "mention": { "icon": "chat", "tone": "amber", "label": "Mentioned" },
        "next": { "icon": "flag", "tone": "sky", "label": "Up next", "lane": "queue" }
      }
    },
    "queue": { "title": "Your queue", "priority": "priority", "due": "due" },
    "who": "author",
    "when": "updated",
    "comments": "comments",
    "mine": "mine"
  }
}
```

## Report back: what a collector prints

A collector is any program. It runs in the Scout's folder as the Kingdom's user, with that user's login environment, and
prints one JSON document to stdout:

```json
{
  "items": [
    {
      "id": "github:pr:owner/repo#123",
      "rev": "2026-11-17T10:02:00Z",
      "title": "Fix the retry loop",
      "subtitle": "owner/repo · checks failing",
      "url": "https://github.com/owner/repo/pull/123",
      "group": "Needs a fix",
      "fields": { "checkout": "~/code/repo", "failing": "test (ubuntu)" },
      "actions": ["fix", "open", "snooze", "done"]
    }
  ]
}
```

- **`id`** must stay the same for the same thing across runs. Everything the app remembers about an item hangs on it.
- **`rev`** changes when the item changes in a way you'd want to see again: a new commit, a new reply. Any string works.
- **`group`** sorts items into sections on the Board.
- **`fields`** are free for templates and for display.
- **`actions`** name keys from `scout.json`. An item with none gets the Scout's defaults.
- **`suggested`** names one of those actions, which the Board draws as the highlighted button. It never runs anything
  by itself.
- **`rank`** (a whole number from 1) puts the item in order on the Board, ranked items first; **`summary`** is one line
  on why it matters. The synthesis step sets these and `suggested`, but whatever a collector sets itself wins.
- **`labels`** (up to ten of `{ "name": "bug", "color": "#d73a4a" }`) are coloured tags the `projects` view draws on the
  row. A bad list is dropped, and the item stays.
- **`project`** (`{ "name": "acme/lantern", "url": "https://...", "description": "...", "owned": true }`) is what the
  `projects` view groups by, falling back to `group`. `owned` draws a crown for a project you own and a handshake,
  "showing your items", for one you contribute to; leave it out to draw neither. A bad block is dropped.
- **`rankSource`** and **`summarySource`** say what set `rank` or `summary` when the collector didn't, as a short word.
  The synthesis step sets `synthesis`. The Kingdom drops any a collector prints, so only it says what the step wrote.

A non-zero exit, a timeout or output that doesn't parse marks the run as failed and leaves the Board as it was. The end
of stderr goes into the run's record, which the hub stores and shows, so a collector must not print a secret there. A collector has two minutes unless `collect.timeoutSeconds` says otherwise; at the
timeout Crystal stops it and everything it started. The collector gets `CRYSTAL_SCOUT`, its Scout's id, and
`CRYSTAL_SCOUT_STATE`, the Scout's `state` folder, which Crystal creates and never reads. It never gets the Kingdom's
node token.

The `command` runs directly, with no shell between, so a script needs its own `#!` line and execute permission. On
Windows, name the interpreter: `["powershell", "-NoProfile", "-File", "collect.ps1"]`.

Each run sends the whole list, never a change list. The hub compares it with the last one, so a collector stays simple
and a missed run loses nothing.

## Keep the ledger: an item's life

The hub stores each item's state per Kingdom, Scout and `id`:

| State | Means | Comes back when |
|---|---|---|
| **new** | not opened since it appeared or changed | |
| **seen** | you opened it, or looked at its Board | its `rev` changes, as **new** |
| **snoozed** | hidden until a time | the time passes, or its `rev` changes |
| **done** | you finished it, here or somewhere else | its `rev` changes |
| **dismissed** | not worth acting on | its `rev` changes |
| **gone** | no longer in the collector's list | it appears in the list again |

**done** covers work that happens outside any system a Scout can reach. A reminder to pay a card is an item; you pay it
in your bank's site and press Done. A collector that issues one reminder each month gives each month its own `id`.

Gone items leave the Board and stay in a short history, so an item resolved elsewhere, such as a merged pull request,
needs nothing from you.

## Read the Board: what it shows

Each Board has a pinned tab in its Kingdom's tab strip, between the Castle and the Quests, like a browser's pinned tab:
an icon with the Board's name in a tooltip, a count of new items, or an amber dot instead of the count when its Scout is
paused or its `scout.json` doesn't load. The icon is the manifest's `icon`, one of `mail`, `pull-request`, `issue`,
`forum`, `calendar`, `bell`, `news`, `checklist`, `ticket`, `chart`, `release` and `package`; any other name, a
misspelt one or none shows the Board's first letter, and never stops the Scout loading. Drag a pinned tab or use
Alt+Arrow to reorder them. Right-click one, or press Unpin from tab strip on the Board, to take it off the strip on this
device; Pin on its Castle card, or Pin to tab strip on the Board, brings it back.

The Castle lists every Board too, pinned or not, each with how many items are new, or why its Scout is paused or its
`scout.json` doesn't load. A Board opens at its own address, `#/k/<kingdom>/b/<scout>`. Like the Summoning Circle,
Boards and their tabs show on wide screens only for now.

- **A summary banner** at the top: how many items are open, how many are new on this visit, how many have a suggested
  action, the counts the Scout declares in `summary`, and when Augury last ranked the list and what that cost. Run now,
  the schedule and what the last run brought back sit beside them.
- **The items** to act on, drawn in the Scout's `view`: a `list` under each `group`, a `checklist` whose box marks an
  item done, or a `table` with a column per field. Opening the Board marks new items seen; their New mark stays until
  you leave.
- **A list reads like a mail client** when `show` names the fields: an avatar and who it's from, the time, the title
  with a line of preview, bold while unread, then the summary. With a `when` field, each group lists newest first, and
  the ranking moves to Counsel. A row's buttons appear on hover or keyboard focus; at rest it tags the suggested action.
- **The projects view** (`view: "projects"`) has two modes, switched beside Run now and remembered per device per Board.
  - **Projects** (the default) has a section per project: ones with items that need you first, then the latest
    activity. A section folds, and the fold is remembered on this device. It shows eight rows, then "Show N more". A row
    has its kind icon, a reason chip, labels, marks, comment count, age and who, with a gold edge on your own items.
  - **The Needs-you window** is a blue window that replaces Counsel here. Each card has the suggested action, Open and
    Later, and the top has "Quest on all". Items whose reason is in the queue lane aren't in it, and don't count toward
    a section's or tile's "Needs you".
  - **The queue window** ("Your queue", or the `queue` block's `title`) sits under Needs you, in a plain panel rather
    than window blue, since nobody is waiting on it. It lists the queue-lane items by priority, then due date, then
    oldest, each card with its reason, project, a priority badge ("P1") and due date ("due in 3d", "overdue 2d") when
    set, the summary, and the suggested action, Open and Later. It shows eight, then "Show N more", and is hidden when
    empty.
  - **Tiles** shows the Needs-you cards as a strip, the queue as a second strip under it, then a tile per project: a
    14-day activity strip counted from item dates, counts, the top four items and "Open all N", which opens Projects at
    that section.
  - **Rollout:** an older hub fails a Scout that declares the view ("needs a newer hub"), and an older Kingdom drops
    `labels` and `project`. Update the hub and the Kingdoms before installing a Scout that uses it. A hub from before
    the queue lane drops `lane` and `queue`, so queue items show in Needs you there.
- **Counsel**, beside the list on wide screens and above it on narrower ones: the items with a suggested action,
  gathered under each action (a chip in that action's colour), best rank first, each with its summary and that action's button, and "Archive all 4"
  where the action takes several items.
- **A Quest you write**, from Counsel: "Quest on all 7" at its top (the best 50 when there are more, the most one
  Quest takes), or Quest beside one suggestion, opens a composer with the items as chips you can leave out, a prompt to
  edit, the folder and the permission mode. Both start from the Scout's first `quest` action with a plain folder, else
  `~` and this device's mode. The folder is used as typed, never filled from an item. Start asks the Kingdom, which
  starts one Quest the way a `quest` action does: your prompt first, then every item as data in an `<untrusted-items>`
  block. An item that leaves the Board meanwhile drops out. A Kingdom older than this is refused with "update this
  Kingdom first".
- **The buttons** each item offers. A `link` opens its filled address in a new tab, and only a web address once
  filled. A `snooze`, `done` or `dismiss` changes the item's state on every open Board. A `quest` or `run` goes to the
  Kingdom, and its button stays disabled until the Kingdom answers. A Quest it starts opens, and a refusal shows why.
- **A batch button** above a group, such as "Archive all 12", for a `run` action with `batch` that several of the
  group's items offer. An action with `confirm` asks "Yes, Archive" in place before it goes.
- **Where an item's order and summary came from**, on hover: "Rank 2 · summary from Augury (the synthesis step)", or
  "from the collector", on the title or anywhere on the row. A faint ✦ beside the title marks a summary the synthesis
  step wrote, and each extra item it added ("Written by Augury"): those words come from a model that read the items, so
  a planted instruction could have shaped them. A rank alone gets no mark; the order already shows it.
- **Folded away:** snoozed items, items set aside (done or dismissed), each with Bring back, and items gone lately.
- **The Scout itself:** Run now, its schedule and next run, what its last run brought back, why it's paused, why its
  `scout.json` doesn't load, and its recent runs with their outcome, timing, items, reason, the end of stderr and cost.

## Consult the oracle: the synthesis step

A Scout with `synthesize` asks the Kingdom's own `claude` to judge the list. By default it runs only when the list,
`synthesize.md` or the Scout's actions changed since the last synthesis (see *Only on Run now* below for a press-only step), and never for an empty list, so a quiet hour costs nothing. It uses the unmodified CLI under the Kingdom's login, in print mode,
with structured output against a schema the Kingdom writes, with tools and MCP servers off and a budget cap:

```
claude -p --output-format json --json-schema <schema> --strict-mcp-config --no-session-persistence
  --max-budget-usd <cap> --tools ""
```

The prompt is your `synthesize.md` as written, then the list as JSON in a block marked untrusted, the same way a
`quest` action's prompt holds its item. It goes on stdin. `synthesize.maxBudgetUsd` sets the cap, up to $5; it's $0.50
when unset. The call may take three minutes. A recording of its real output is in `apps/crystal/test/fixtures`.

What it may return is fixed:

- for an item: a rank, a one-line summary, and one suggested action from that item's own list;
- extra items of its own, such as "a filter would archive these 40 newsletters". These may offer only the Scout's
  `snooze`, `done` and `dismiss` actions: a script, a Quest or a link needs an item a collector vouched for, and the
  model may have read text written to steer it.

The Kingdom checks the answer against the schema and drops anything else, such as a suggestion the item doesn't offer.
An extra item's id is `synthesis:` and a hash of its title, so dismissing one sticks for as long as it's worded the same.
Every rank and summary the step sets carries `rankSource` or `summarySource` `synthesis`, which the Board shows as a
mark and a tooltip, so its words are never mistaken for a collector's.
Each run records its cost in Gold beside the Board.

When the step fails (the prompt file can't be read, `claude` isn't logged in, the budget runs out), the run still
succeeds with the plain list, and the Board's Recent runs shows why on that run, in amber. A failed call isn't made
again on schedule until something changes, so a broken step doesn't spend every 15 minutes; each run repeats the
reason meanwhile. Once you've fixed the cause, Run now tries again. The Kingdom keeps the last answer in memory, so after Crystal restarts, a Scout's next
run synthesizes once more.

Cost is the reason synthesis is optional and runs only on change, or only on a press. Every `claude` call loads the Kingdom's full Claude
setup, so even a small call has a fixed cost, and it spends that Kingdom's plan usage. A recorded synthesis of three
items cost $0.04 (the API-equivalent figure the CLI reports); a Kingdom with more plugins, skills or CLAUDE.md files
pays more per call. A Scout that ran synthesis every 15 minutes regardless would spend about $4 a day or more.

**Only on Run now.** Some lists change on almost every run: an inbox does. There, "only when the list changed" still
means a call every 15 minutes, and a recorded call over 100 mail threads cost $0.57. Set `synthesize.when` to `now`
and scheduled runs only collect; pressing Run now collects and synthesizes, if anything changed since the last press.
Between presses, the last answer that succeeded is carried over: an item keeps its summary and suggestion while it's as
the answer saw it, so a thread with a new reply loses them. Its ranks stay only while the answer judged every item,
since the Board puts unranked items last and new ones would sink below old, and its extra items stay only for the
very list they were written about. A failed press keeps the last good answer and repeats its reason on each run. The
answer is kept in memory, so after Crystal restarts the Board shows the plain list until the next press. Run now says
on hover that it may spend plan usage. Kingdoms and the hub need this release before a Scout sets `now`: an older one
fails that Scout's `scout.json`. `changed`, the default, keeps the behaviour above.

The step keeps the Kingdom's settings. Leaving them out (`--setting-sources ""`) saved about a tenth in that recording,
but it would also drop settings a Kingdom may need for the CLI to work at all, such as an `env` block that points it at a
proxy.

## Take up the posting: actions

| Kind | What it does |
|---|---|
| `quest` | starts a Quest on this Kingdom from a prompt template, with a project, a permission mode and optionally a worktree |
| `run` | runs a script of yours with the chosen items as JSON on stdin; can ask to confirm first |
| `link` | opens a URL |
| `snooze`, `done`, `dismiss` | change the item's state |

A `run` action can take several items at once, so "archive these 12" is one press. On success it can mark its items done
or dismissed, as the action says.

The hub sends a `quest` or `run` action to the Kingdom with the items as the hub stores them, never as a browser sends
them. An item the collector no longer lists can't be acted on, and both the hub and the Kingdom check that each item
offers the action.

**The Kingdom starts the Quest.** A `quest` action starts one Quest from one item, the same way New Quest does: in
the action's `project`, with its `mode` and, when `worktree` is set, in a worktree of its own. It then appears in the
app like any other Quest, and its header shows "From" and the item's title, which opens the Board.

- **`prompt`** names a file in the Scout's folder, read as it is. Its <code v-pre>{{...}}</code> placeholders are not filled: your
  instructions say "the item below", and the item follows them.
- **`project`** is filled from the item, such as <code v-pre>{{fields.checkout}}</code>. Once filled, it must be a full path or start
  with `~/`, must not contain `..`, and must be a folder that exists. Otherwise the Quest doesn't start, and the Board
  says why.

**Item text is untrusted.** A pull request comment or an email body is written by someone else, and may be written to
steer an agent. So the Quest's prompt is your template, then a line saying the item is untrusted data, then the item
as JSON between `<untrusted-item>` and `</untrusted-item>`. A Quest you write from Counsel is built the same way, with
your words in place of the template and its items between `<untrusted-items>` and `</untrusted-items>`; the browser
sends only your words and the item ids, and the hub sends the items as it stores them. Every `<` inside the JSON is escaped, so the item can't
close the block early. The Quest's permission mode still applies, and a Scout's synthesis step has no tools at all.

**A script gets the items on stdin.** A `run` action's `command` runs in the Scout's folder, with no shell between, like
a collector. It gets `CRYSTAL_SCOUT`, `CRYSTAL_SCOUT_STATE` and `CRYSTAL_SCOUT_ACTION`, the action's key, and reads
one JSON document on stdin:

```json
{ "scout": "mail", "action": "archive", "items": [{ "id": "msg:1", "title": "Weekly digest" }] }
```

Exit 0 means it worked, and `then` marks the items `done` or `dismissed`. Any other exit leaves them as they were and
shows the code and the end of stderr on the Board. A script has two minutes. What it prints to stdout is ignored, up to 1 MB; more than that fails the action.

## Keep the watch: schedules

- **Cron, five fields, with a time zone.** The time zone is required, so a Scout means the same thing on every machine.
  `Run now` on the Board runs it at once.
- **A missed run catches up once.** After a laptop sleeps through several, the Scout runs once when it wakes, not once
  per missed slot.
- **No overlap.** A run that's due while the last one is still going is skipped and recorded as skipped.
- **A fixed jitter per Scout**, under half a minute, so Scouts due at the same minute don't all start at once.
- **A new Scout waits for its first time.** Adding one, or changing its schedule, doesn't run it at once: use Run now.
- **Repeated failures pause the Scout.** After three failed runs in a row it stops and says so on its Board. Run now
  still works, and the first run that succeeds puts it back on its schedule. A token that needs signing in again shows
  up this way.

Each Scout's next run and failure count are kept in a file beside the scouts folder, named after it
(`scouts-state.json` by default), so a pause and a missed run survive a restart. While the hub is out of reach, the
Kingdom holds each Scout's latest few runs and its latest list, and sends them when it reconnects. They're held in
memory, so a restart in the meantime loses them, and the next run sends the whole list again.

## Where it runs

- **On a Kingdom** is the main case, and the only one at first. The Scout's logins never leave the machine, and the hub
  stores only items and runs.
- **On the hub** comes later, for sources that need no personal login, and for one Board drawn from several Kingdoms.
  The hub holds no Claude login, so a hub Scout can't synthesize by itself: it stays plain code, or names a Kingdom to
  do that step. Its `quest` actions name a Kingdom too.

## Who holds what

- **The Kingdom** holds the Scout folders, their scripts and state, every credential a script uses, and the scheduler.
  Crystal never reads or relays a credential, though a collector that prints one to stderr sends it to the hub with
  its run.
- **The hub** stores each Scout's definition as the Kingdom reported it, its items and their states, and a short
  history of runs with their outcome, timing and cost. It shows the Boards and sends notifications.
- **The browser** draws a Board from a fixed set of views (a grouped list, a checklist, a table and a projects view).
  No code from a Scout runs in the app.

The protocol stays additive: a `scouts` flag on `hello`, new frames beside the existing ones, and new hub tables. A
Quest's event stream doesn't change. Boards stay off phones for now, like the Summoning Circle.

## Field notes: the first two Scouts

**A Quest Board** uses the Kingdom's own `gh` login, so no token is stored anywhere new. A working one ships as an
example: [`examples/scouts/github`](../examples/scouts/github/README.md).

- It fills a `projects` Board. Repositories you maintain (admin or maintain permission, not archived, pushed lately)
  are listed in full, with aliased per-repository GraphQL queries, five repositories a call. Elsewhere, GitHub search
  finds your items: your open pull requests, review requests, and open issues you wrote or are assigned. An issue you
  opened and assigned to yourself goes to the queue as Up next, ordered by its `P0`-`P3` label and milestone due date.
- GraphQL fields give each item its reason: `reviewDecision`, `statusCheckRollup` and `mergeStateStatus` give review
  requested, checks failing, changes requested and ready to merge.
- Whether a pull request waits on you or on them is no GitHub field. The collector works it out from the last person,
  not bot, who commented, reviewed or pushed.
- The notifications API is a cheap check for change: a reply of "not modified" costs no rate limit. Ask by ETag
  (`If-None-Match`); `If-Modified-Since` got a full reply in testing. It accepts the `gh` login's token but refuses
  fine-grained tokens and GitHub App tokens. A check finishing makes no notification, and nor does anything you do
  yourself, so a kept list still needs a fresh search now and then.
- GitHub's rate limits are per account. Run one such Scout per GitHub account, on one Kingdom.

**A mail Board** needs a Google sign-in, which is the hard part. A working one ships as an example, with the sign-in
step by step: [`examples/scouts/gmail`](../examples/scouts/gmail/README.md).

- You create your own Google Cloud project with a Desktop OAuth client, with the `gmail.modify` scope, plus
  `gmail.settings.basic` to create filters.
- In **Testing**, with yourself as a test user, a sign-in expires every seven days. **In production** (unverified) it
  lasts, but Google enables publishing only once the app's Branding page has a home page, privacy policy and terms
  links on an authorized domain.
- A new project allows 6,000 units of Gmail quota a minute per user, and reading 100 threads in full tripped it within
  seconds: the collector waits and retries, and a first read of 100 threads took 75 seconds.
- Synthesis runs only on Run now (`synthesize.when: "now"`): a mail list changes on nearly every run, and one call over
  100 threads cost $0.57.
- On a Workspace account, an admin may block the app or the scopes.
- A collector reads changes with `history.list` from a saved position, which needs no public address. When Google says
  the position is too old, it reads the inbox in full again.
- Archive removes the `INBOX` label. Spam adds `SPAM`; Google doesn't document whether that teaches Gmail the way its
  Report spam button does, so treat it as moving the mail only. A filter is created through the settings API.
- A token that fails makes each run fail with a sign-in message, and the third failure in a row pauses the Scout.
- Synthesis sees headers and a trimmed, cleaned body, never attachments, and redacts codes and account numbers.

## Not planned

- **Code from a Scout in the app.** Boards are drawn from data, so a Board can't run anything in your browser.
- **Acting without you.** A Scout suggests; you press the button. Rules that act by themselves are a separate idea.
- **Triggers from webhooks or GitHub events.** Schedules come first. A trigger needs a public address, which a Kingdom
  doesn't have.
