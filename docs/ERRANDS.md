# Errands

A Quest comes back from the road with a few chores it couldn't do for you. The work is tracked in the
[v0.9 Errands and Deeds milestone](https://github.com/crystal-bridge/crystal-bridge/milestone/11) and #288.

An **Errand** is a step a Quest leaves for you to take after a turn: test something by hand, run a command, install an
update. It lives on the hub, outside the Quest's chat, so you can close the Quest and still find the step from any
device. You tick it off when it's done.

Errands come from two places only: a Quest, through a tool Crystal gives it, and your own hand. There is no "Save as
Errand" on each message.

## The parts

| Part            | What it is                                                                 | Where it lives        |
| --------------- | -------------------------------------------------------------------------- | --------------------- |
| **Errand**      | a title, a Markdown body and a state (open, done or dismissed)             | the hub, per Kingdom  |
| **`errand` tool** | how a Quest leaves one: `mcp__crystal__errand` on Crystal's MCP server   | each Kingdom's Crystal |
| **Errands panel** | the Castle's list of a Kingdom's open Errands                            | the web app           |

## Leave word: the `errand` tool

Crystal's MCP server, which every Quest already has for approvals and its title, gains a tool:

```json
{ "title": "Try the new export by hand", "body": "Open a large log and press **Export**." }
```

- `title` is one line of plain text, up to 120 characters, checked as a Quest title is.
- `body` is Markdown, up to 8000 characters. It may hold prose, fenced code blocks and links.

An Errand's project is the Quest's project folder: the repository's folder for a Quest in a worktree, not the worktree,
so a Patrol's runs in fresh worktrees still group together. The tool takes no project of its own, because a name the
model makes up would never group with the folder paths New Quest and Patrols use.

The tool answers with the Errand's id. Crystal allows the tool itself on both engines, as it does `title`
(`--allowedTools` for the stream engine, the settings allow list for the interactive one), so a call never raises a
permission card, in any mode. `pnpm smoke` checks both.

The CLI defers MCP tools behind ToolSearch, so a Quest only uses one its system prompt tells it about (see
`test/fixtures/README.md` in `apps/crystal`). Crystal's appended system prompt gains one line: when you finish with
steps the user must take themselves, load `mcp__crystal__errand` and leave one Errand for each, and still say them in
your reply. The reply keeps them, so nothing is lost if the Errand isn't stored.

The Errand line goes with the title line, in the one `--append-system-prompt` value Crystal passes when a Quest starts.
The CLI stores a session's appended prompt and applies it again on every `--resume`, and it ignores one passed on a
resume, so the line lasts the Quest's life. A fork carries its source's line and ignores one passed with it, so a fork
of a Quest started before Errands shipped has none ([recorded](https://github.com/crystal-bridge/crystal-bridge/blob/main/apps/crystal/test/fixtures/README.md#the-appended-system-prompt-on-resume-cli-21330)).
A Quest started before Errands shipped, or adopted from outside the bridge, has no line and leaves no Errands; its
replies still carry the steps.

A Quest may leave at most 10 Errands in one turn; past that, the tool refuses with the reason. Crystal counts them per
turn, so it holds no state that a restart would lose. A Quest can't edit, tick or remove an Errand. Those stay yours.

## Keep the list: on the hub

Crystal sends each call as an `errand.left` event in the Quest's stream, engine-neutral like every other event: an
engine without MCP can send the same event another way. The hub stores the event as usual and also writes an `errands`
row, in a new migration. The row is keyed by Kingdom and id, as Patrols are, and written only if no row has that key,
so a repeated or malformed event never refuses the event itself.

| Column            | Holds                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| `id`              | the Errand's id (a UUID from Crystal, or from the hub for one made by hand) |
| `node`            | its Kingdom                                                                |
| `session`, `seq`  | the Quest and the event that left it; empty for one made by hand           |
| `project`         | a project folder; empty for one made by hand without one                   |
| `title`, `body`   | as given, edited by hand later if you choose                               |
| `state`           | `open`, `done` or `dismissed`                                              |
| `left_by`         | who left it: `quest` or `you`                                              |
| `created`, `updated`, `closed` | times; `closed` is when it was closed (ticked done or dismissed); a later change between done and dismissed keeps it |

Clients read a Kingdom's Errands over HTTP, and get each change as an additive `errands` frame, so every device sees a
tick at once. Older clients ignore the frame.

**Keep:** open Errands stay until you act on them, up to 500 open per Kingdom: past that the hub drops a Quest's new
Errands (the event is still stored) and refuses Add Errand until you tick or dismiss some. Done and dismissed ones fold away and are deleted 30 days after they
were closed, counted from `closed`. The fold says so. Forgetting a Kingdom deletes its Errands, and closing a Quest keeps
them. [What Crystal Bridge stores](HUB-DATA.md) has an `errands` row.

A fork starts with no Errands: its earlier events belong to the Quest it came from.

## Run the errand: in the app

**On the Castle**, the Errands panel lists the Kingdom's open Errands in one of two layouts, chosen by a switch on the
panel and kept per device:

- **Checklist**, in the right column above Haunts: one line per Errand, grouped by project, each project in its own
  colour, with a bar across the top showing each project's share.
- **Cards**, a band across the Castle: a card per Errand with its body shown, grouped by day (today, yesterday, earlier),
  each card topped in its project's colour, with an icon for what left it.

Each Errand shows what left it: a Quest, a Patrol's Quest, or your own hand. The link opens the Quest, not the turn
within it, and a link to a closed Quest opens it as the Chronicle does. Checklist is the default layout.
Done and dismissed ones fold under a count, titled "Done and dismissed", with the 30-day note. **Add Errand** writes one by hand, with the same limits as the tool: a title, Markdown details and an optional
project from the Kingdom's projects. Edit changes the title and details; the project stays. Each Errand can also be
ticked done, dismissed, or reopened from the fold. With no open Errands, the panel says so in one line.

**In a Quest**, the side panel shows that Quest's Errands. Where the tool was called, the chat shows a line, such as
*"Your Quest left you 2 Errands."*, counting only the calls that left one (a refused call, or one with no answer when
the turn ended, isn't counted). Unfolded, it lists the title of each one left, then why any were refused. Its Show
button opens the side panel at that block. The side panel has no Add, since an Errand made by hand has no Quest. The Classic theme says Follow-ups.

**On the Kingdom's tab**, a count of open Errands, with an icon and a label for screen readers, in teal, which is neither the
waiting count's colour nor the gold of a Quest you haven't seen, since an Errand never holds a Quest up.

The body renders as the chat's Markdown does, with no raw HTML. Each code block has a copy button; nothing runs a
command for you.

**On a phone**, the Castle shows the list to read, copy a command, tick and reopen. Adding, editing and dismissing stay
on wider screens.

## Tie up loose ends: Quests, Patrols and notifications

- **Done notifications.** When a finished turn left Errands, its done notification says so: *"…and left you 2
  Errands."* No separate notification is sent. At the Discreet level the notification says nothing about Errands, as it
  says nothing about the Quest.
- **The attention sort** (a finished Quest stays marked until viewed). Ticking an Errand doesn't mark its Quest seen:
  you may tick it from the Castle without reading the turn, or a later turn may have finished since.
- **Patrols.** A Patrol's Quest has the tool like any Quest and runs in the Patrol's mode, with nobody watching. Its
  Errands wait on the Castle like any others, and the Patrol log's report shows how many it left. A script Patrol has
  no Quest, so it leaves none.

## Mind the source: trust

An Errand's text is written by the Quest, and a Quest reads untrusted text: web pages, pull requests, Board items. A
prompt injection could leave an Errand with a harmful command in it. Read a command before you run it, as you would one
in the chat. The app copies it and never runs it, and renders no HTML or scripts from the body. The
[security model](SECURITY-MODEL.md) has an Errands row.

## Who holds what

- **The Kingdom** offers the tool and sends the event. It stores nothing.
- **The hub** stores the events and the `errands` table. Nothing engine-specific becomes a column.
- **The browser** shows the panel, the Quest's list and the tab count.

The protocol stays additive: a new event type, a new frame, a new table in a new migration, and HTTP routes. Older
Kingdoms and clients ignore all of it. An older hub stores `errand.left` as an event it doesn't know and shows no
Errand, so update the hub before the Kingdoms, as [Operations](OPERATIONS.md) says for any new event; the steps are
still in the Quest's reply.

## Not planned

- **"Save as Errand" on each message.** It would clutter every message for a rare fallback.
- **A Quest picking an Errand's project.** It follows the Quest's folder.
- **Ticking an Errand to mark its Quest seen.** See the attention sort above.
- **A Quest ticking its own Errands.** An Errand is for you; if the Quest can do the step, it should do it, not leave it.
- **Errands across Kingdoms** in one list. Kingdoms first, as with Scouts and Patrols.
- **Due dates and reminders.** A Patrol covers work on a schedule.
