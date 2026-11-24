# Changelog

Notable changes, newest first. Versions follow [semantic versioning](https://semver.org). Releases before 0.3.0 share
one entry.

## 0.8.0

### Added

- Each Patrol run carries a one-line summary of what it came to: the start of its Quest's reply, or its script's last
  line of output. A run can be marked done, which the hub keeps for the Board.
- A Board shows when each of its Patrols sets out next, and a Patrol log beside the list with their latest reports: how
  each run ended, its summary, and buttons to open the Quest or a script's output, run it again, or mark it done.
- "Patrol this" beside a Board's Quest action opens New Patrol drafted from that item's Quest, reporting back to the
  Board. See [Post to a Board](docs/PATROLS.md#post-to-a-board).

- A Quest names itself once it understands the ask, in the theme's voice ("The Siege of the Flaky Smoke Test"), with a
  plain name for the Classic theme, and keeps that first name. It does this through `title`, a tool the Crystal gives
  every Quest and allows up front. On a desktop, rename a Quest from its tab's right-click menu; a name you give it
  stays, on every device. See [How it fits together](docs/CONCEPTS.md#what-happens-in-a-session).
- A Quest leaves you Errands, steps to take after a turn, through `errand`, a tool the Crystal gives every new Quest and
  allows up front; the chat says how many a turn left. See [Errands](docs/ERRANDS.md).
- Every finished turn leaves a turn record on the hub, with its files and pull requests counted once the Crystal's diff
  is in. A Quest records Deeds through `deed`, a tool every new Quest gets and is allowed up front, at most 3 a turn.
  Close can record a Quest's Deeds from a short digest of it, with `CRYSTAL_CLOSING_MODEL` and
  `CRYSTAL_CLOSING_BUDGET_USD`. See [Deeds](docs/DEEDS.md).
- The Castle's Errands panel lists a Kingdom's open Errands as a Checklist by project or as Cards by day, a choice kept
  per device. Tick one done, dismiss it, reopen it from the fold, add one by hand, or edit one. On a phone it shows the
  list to read, copy and tick.
- A Quest's side panel shows its own Errands, and the chat line's Show button opens it there. Each Kingdom's tab shows a
  teal count of its open Errands.
- A done notification adds "and left you 2 Errands." (Follow-ups in the Classic theme), and a Patrol's report in the
  Patrol log says how many Errands its run left.
- The Castle's Deeds feed lists a Kingdom's turn records and Deeds as a timeline by day, filtered by project, and reads
  only on a phone. Close offers Record its Deeds, a choice kept per device and greyed with a reason when it can't run.
  The chat has lines for a Deed and for the Deeds at Close, and a Quest's side panel shows its own Deeds. See
  [Deeds](docs/DEEDS.md).
- Full releases and pre-releases publish the Kingdom and hub to npm as `@crystal-bridge/kingdom` and
  `@crystal-bridge/airship`, from the release's attested tarballs by trusted publishing (pre-releases under `next`).
  Edge builds stay on GitHub Releases. See [Releases](docs/OPERATIONS.md#releases).
- Each Kingdom keeps a Library, one folder of Tomes (`CRYSTAL_LIBRARY_DIR`, by default `~/.crystal-bridge/library`;
  `off` turns it off), which can be an Obsidian vault or a git repository. Its Library tab, right after the Castle tab,
  lists, renders and edits the folder: Markdown with Mermaid diagrams, maths, highlighted code, images, wiki links,
  backlinks, frontmatter and an outline, and a plain editor that checks the version it edited from and keeps drafts on
  the device. The Castle gets a Library card, a phone reads the Library, and a Scroll in the Library offers Open in the
  Library. New Quests learn where the Library is; `CRYSTAL_LIBRARY_QUESTS=folder` also gives them its folder. Paths are
  confined to the folder, and writes are Markdown only. See [The Library](docs/LIBRARY.md).
- An HTML Tome shows in a sandboxed frame that can't read the app. It can still contact other sites (through WebRTC,
  through preconnect in Safari, or by navigating its frame), and its badge says so. See
  [Open the sealed pages](docs/LIBRARY.md#open-the-sealed-pages-html-tomes).
- `pnpm test:browser` proves the Library's sandboxes in Chromium and WebKit, and CI runs it and the Kingdom's tests on
  macOS.

### Fixed

- A schedule rule with long BY lists, such as every minute of every day of the month, no longer stalls its Kingdom for
  seconds each time it works out the next run, nor the Patrol form's preview (#302).

## 0.7.0

### Added

- A Kingdom runs Scouts: each folder under `~/.crystal-bridge/scouts/` names a collector and a schedule, and the Kingdom
  runs it, sends the hub what it found and pauses it after three failures in a row. See
  [Scouts and Boards](docs/SCOUTS.md).
- Each Scout gets a Board: listed on the Castle and pinned as a tab in its Kingdom's strip, with new-item counts, Run
  now, the schedule and recent runs. A Board draws its items in the Scout's view (a list, a checklist, a table, or a
  projects view with Projects and Tiles modes), and its banner, groups, sender colours, icons and labels come from
  `scout.json`.
- A Board's buttons act on its items: a `quest` action starts a Quest from an item, a `run` action hands items to the
  Scout's script, and Counsel gathers suggested items with their buttons. "Quest on all" writes one Quest over several
  items, which reach the model marked as untrusted.
- A Scout with `synthesize` has the Kingdom's own `claude` rank its list, sum each item up in a line and suggest an
  action, with no tools and a budget cap (`synthesize.maxBudgetUsd`, $0.50 unless set). It runs when the list changed,
  or only on Run now with `synthesize.when: "now"`. A ✦ and a tooltip mark what the step wrote. When the step fails, the
  Board keeps the plain list and says why.
- Two example Scouts in `examples/scouts/`: GitHub (one projects Board per account, with a Needs you window and a Your
  queue window for your own issues by priority and due day) and Gmail (your inbox by category, with Archive, Spam and
  Filter sender).
- The hub installs updates from the app: the Ship's Log offers Install updates when a newer release is out, and
  Kingdoms set to When approved follow. Check for updates asks GitHub at once.
- Every merge to `main` publishes an edge build, for hubs that follow development; full releases are tagged by hand.
  See [Releases](docs/OPERATIONS.md#releases).
- A Quest that finishes or fails while you aren't looking stays marked until you open it, on every device. The Tavern
  lists those Quests after what needs you, and the Airship's Kingdom cards sort Quests by attention.
- A Scout's `schedule` takes an RFC 5545 recurrence rule (`rule` with a `start`, such as every other Tuesday or the
  last weekday of the month) or a single time (`once`) besides cron, each in its time zone. Patrols will use the same
  engine. Existing cron schedules work as before.
- A Kingdom runs Patrols: each folder under `~/.crystal-bridge/patrols/` names a schedule and either a Quest (a prompt,
  a project and a mode) or a script, and the Kingdom sets out at each time, catches up a missed run only within its
  `catchUp` window, stands a Patrol down after three failures and reports every run to the hub. A permission prompt in a
  Patrol's Quest that nobody answers within `waitForYou` ends the run as needing you. See [Patrols](docs/PATROLS.md).
- The Castle's Watchtower lists a Kingdom's Patrols with their next run, last outcome and run history, and runs, pauses,
  resumes and deletes them. On a wide screen, New Patrol and Edit open a form for Quest Patrols: a schedule from a
  preset, a Repeat builder, a rule, cron or a single time, with the next run times worked out on the Kingdom before you
  save.

### Changed

- New Quest now has the same layout as a running Quest: the Inventory, Belt and side panel are there before you start,
  and the prompt box sits at the bottom. The Inventory and slash suggestions are live from the Kingdom for the picked
  project, with no prompt sent. A Kingdom on an older release lists nothing here until it's updated.
- The Classic theme calls the Tavern "For you".

### Security

- The release check that a Kingdom and the hub run before an update now uses minimatch 11, which clears a
  medium advisory (GHSA-g3hv-75wg-m249) in the version it used before.

### Fixed

- An interactive Quest no longer stops before its first message at a prompt to trust its folder for attached files,
  which Claude Code 2.1.329 asks about.
- A Cast on a machine whose `tail` can't watch files, such as Ubuntu 26.04's when it has no inotify left, no
  longer finishes before its last lines are read.
- A link or reload that opens a Board, a Castle, New Quest or the Airship stays there, instead of jumping to a saved
  Split View's Quest.

## 0.6.0

### Added

- Hovering a Spell, Item or Guild member in the Inventory shows its description, read by the Kingdom from the file that
  defines it. A Kingdom on an older release just shows no tooltip.
- A team of helpers now looks like a Party: helpers out together take different Classes, by job where the job says
  something. Levels aren't affected, since XP goes to a Quest's leader.
- Keyboard shortcuts for moving between Quests and Kingdoms, and to the next Quest needing you, without the mouse. `Alt+/`
  lists them.

### Security

- A hub on token login no longer lets a request through unchecked because of how its path is written. Update any hub
  reachable by people you don't trust.
- The hub refuses `/client` and changes that come from a page on another site, which a logged-in browser would otherwise
  carry out for it.
- Remote images in agent text and repo files no longer load by themselves: they show as links, and the hub sends a
  Content-Security-Policy.
- Removed logins and rotated node tokens lose their open connections within 30 seconds, and hub databases and backups are
  private (0600).
- Crystal's node token is kept out of git commands run in a Quest's folder, and text typed into an interactive terminal
  can't escape its paste.

### Changed

- Version skew is safer: a hub stores event types it doesn't know instead of leaving a newer Kingdom resending them, one
  unreadable event no longer costs a tab a whole replay batch, and older tabs and hubs keep newer Appearance fields when
  they save.
- A Kingdom that can't read a command says so in the Quest instead of leaving the tab waiting.
- `join` checks Node, the service manager and its port before spending the code, and confirms the Kingdom started. A
  failed connection prints the real reason.
- Kingdoms can cross a future protocol bump by themselves. A Kingdom already installed needs one `adopt` from this release
  to survive `brew upgrade node`.
- A job's output files on a Summon use your login's umask, and the docs show how to stop a Cast by hand.
- An interactive Quest applies a permission mode change at the next message.

### Fixed

- A turn starting just as the last one finished kept its list of changed files, a process coming up between interactive
  turns no longer leaves a Quest showing as running, and New Quest says so when an attached file can't be read.
- Split View ends when one of its Quests is closed, from any tab or device: the other Quest takes the full view, moving to
  its Kingdom if that's a different one. A closed Quest in a saved pair no longer comes back after a reload.
- One Quest failing to start, or a command failing, no longer takes its Kingdom down with every other Quest.
- On Windows, stopping or restarting an interactive Quest no longer crashes Crystal, Casts end on a negative exit code or
  a crash, and a profile path with a space no longer stops every Cast.
- Interactive Quests end a turn on an API error, count turns the CLI starts by itself as busy so deploys wait for them, and
  hold follow-ups while a terminal card is open.
- A typo in `CRYSTAL_SUMMONS` no longer stops a Kingdom starting.
- The hub stays up through a full disk without discarding events, a cloned or leftover Crystal can't knock out a live
  Kingdom, search no longer freezes every Quest, and backups finish on a busy hub.
- Follow-ups and New Quest briefs stay safe until they've really arrived, and a dropped link, an expired login or a
  stranded approval card now says so instead of failing silently.
- The Summoning Circle catches up after a reconnect and always lists running Casts, and follows leave no `tail` behind on
  macOS targets.

## 0.5.1

### Fixed

- A Kingdom notices a dead link to its hub within a minute and reconnects, and a hub stops listing a Kingdom that went
  away without a word. A restart of a proxy in between, such as Tailscale updating itself on the hub's machine, used to
  leave a quiet Kingdom offline until it next had something to send, which could be hours.

## 0.5.0

### Added

- A Quest cut off mid-turn by a Crystal restart, crash or reboot comes back by itself, and the agent is told what happened
  to its last tool call. If it was cut off more than 30 minutes ago, or twice in a row, it stays stopped and you're
  notified. A Quest started before this version stays stopped too, because its permission mode isn't on record.

### Changed

- Editing `CRYSTAL_SUMMONS` in `crystal.env` no longer needs a Crystal restart. The list is read again at each `summon`
  call and every few minutes, and a typo keeps the last good list. A Cast running on a machine taken off the list is
  seen through to its end.
- A running Cast's log no longer fills its target's disk: on Windows and most Linux file systems, only the last 64 to
  128 MB stays on disk, and a long job loses no place in the log. macOS targets keep the whole log.

### Fixed

- The side panel says Node, not Kingdom, in the Classic theme.
- A rebuilt Quest keeps its own permission mode. It used to come back in the Kingdom's default, which could be looser.
- A Quest's background command or agent counts as busy only while it runs. A Quest that had ever started one used to
  count as busy until it closed, which held its Kingdom back from updates through several releases, with no reason
  shown.
- A running Monitor no longer holds a Kingdom's update or deploy on the stream engine, as it already didn't on the
  interactive one. It still keeps its Quest's process from an idle stop.
- A follow on the Kingdom itself no longer leaves its `tail` running once it stops, which kept a process and the log's
  disk space for good.
- A turn the CLI starts by itself, when background work reports in, now counts as a turn: an update waits for it, an
  idle stop can't cut it off, and its files changed show.
- A background command or Monitor that has finished or been stopped leaves the Party, and Background Tasks shows it as
  finished rather than running.

## 0.4.3

### Added

- `summon machines` gives the Kingdom's current machines. A resumed Quest keeps the tool description it first loaded, so
  the list there can be out of date, and the description now says so.

### Fixed

- Messages the agent wrote for you now show in the chat and in search. The CLI can send one as a thinking block with no
  text, which the chat hid, and about a fifth of a Quest's messages could go missing that way.
- A finished Cast stays on record until its folder has really gone from the target. A machine that was off at the end
  of the week used to keep the folder for good, with nothing trying again.
- A refused `summon start` shows only the reason, without the SSH client's own warnings or a server's banner above it.

## 0.4.2

### Fixed

- `summon start` refuses a folder that isn't on the target, where the Cast used to fail later with an exit code that read
  as a missing command.
- The `summon` tool says that a cancel sends no wake.
- An approval or question on the stream engine stays open for a day. The CLI used to give up after 5 minutes with a tool
  error, and the agent could retry and leave the card you were reading stale.
- `summon cancel` returns the Cast's final state, where a slow target such as Windows could still show it as running.

## 0.4.1

### Added

- The chat shows who did what. A helper's tool cards carry its sprite, and it gets one line setting out and one coming
  back or KO'd, with its prompt and report folded inside.

### Changed

- Tool chips speak the theme: Attacking or Casting by Class, then Success, Miss or Blocked, with the plain word as the
  tooltip.
- Helpers take their Class from their job first, then their agent type, and anything left gets a stable pick, so a party
  of helpers is no longer all Wizards. The Party and the Battle card agree on each one.

### Fixed

- The docs site's links inside page text work again: 29 of them were dead. A check of the built site now holds this.
- The docs answer whether one machine is enough, and the Getting started steps work with no checkout on a current Node.
- A Cast no longer loses the last lines of its log when a routine check notices it ended before the log has been read.
- A clean reboot of a Linux or macOS Summon now reports its Cast as lost, as a forced restart does, not as a failed job.
- `summon start` says when a Cast has to wait for its turn, where it used to look as if it had begun.
- The Summons docs' connection check works on Windows, and they say what a restart costs the Quest asking for it and how
  large a Cast's log can get.
- Crystal's log says when it reaches the hub.

## 0.4.0

### Added

- Summons: a Quest can start a long job on a machine you can reach by SSH, or on its own Kingdom, and stop spending
  tokens on it. The job survives dropped connections and Crystal restarts, shows in the Castle's Summoning Circle, and
  ends with one notification or one wake-up. List machines in `CRYSTAL_SUMMONS`; nothing is installed on them.
- Each Summon runs one Cast at a time unless you raise its limit, and Kingdoms sharing a machine take turns. A script
  can name its Cast and show a live count with `::summon` lines.
- A Windows machine can be a Summon, with OpenSSH on it and nothing installed.

### Changed

- In the Crystal theme, MCP servers are now Runes, plugins are Equipment, and shell mode is the Command Sigil. Relics are
  gone. A saved Belt keeps working, and the Classic theme's words don't change.

## 0.3.0

### Added

- A hub can hold its Kingdoms back until you approve a release, with a hub-wide choice in the Ship's Log.
- A Ship's Log on the Airship shows the hub's release, health and how its Kingdoms are getting on, and says when a
  newer release is out, with its notes and how to take it. The logo gets a badge for it.
- A Castle's Garrison shows the Heroes who have led Quests in that Kingdom, with their levels there.
- A Quest's Stats fit every plan: HP is the shortest limit the plan has, a new Stamina bar shows a longer one when
  there is one, a bar's tooltip names its limit, and a bar warns when its limit says it's nearly out.
- The docs site opens with what Crystal Bridge is and why you'd want it, explains the model on one short page, and has
  a guide to installing the app; the reference pages are grouped by what you're trying to do.

### Changed

- The Settings button uses a gear-and-hammer from the icon set, in place of a hand-drawn pixel gear.

### Fixed

- A release carries its own attestation, so a Kingdom updating to it doesn't depend on GitHub's API or its rate limit.

## 0.2.0 and earlier

### Added

- Windows Kingdoms: `join` and `leave` work there through a sign-in task that needs no administrator, which restarts
  Crystal after a crash, and both engines run Quests, whether `claude` came from the native or the npm install.
- The Castle offers Update Claude Code when a Kingdom's CLI is behind, running the CLI's own update while no Quest
  there is busy.
- A Quest's tab shows its project under the title.
- Split View's picker shows each Quest's project beside its Kingdom, except for a Discreet Kingdom.
- A docs site built from `docs/` with VitePress, and a configuration reference that a test holds to the code.
- Cmd+Enter (Ctrl+Enter off a Mac) starts a Quest from the New Quest prompt.
- Kingdoms, Quests, approvals and question cards, Split View, Web Push, found-session adoption, the Airship home.
- The interactive engine (experimental), with recovery when the terminal swallows a typed message.
- Theme words for each kind of step on the Party card; shell mode in the prompt box; toolbar icons; in-app Credits.
- `scripts/deploy-all.sh` with a deploy config outside the repo; deploys say why a Quest counts as busy.
- Git hooks and CI: formatting, types, tests, the repo scrub and a secret scan.
- The Kingdom agent builds into one installable package, `@crystal-bridge/kingdom`, and a `v*` tag publishes its
  tarball to a GitHub Release with build provenance.

- The Castle warns when a Kingdom's version is older than the hub's, and a refused Kingdom logs why.
- The Castle shows each Kingdom's Claude Code version and when an update is available.
- `docs/OPERATIONS.md` states which hub and Kingdom releases work together.

- The hub makes one-time join codes that trade for a new Kingdom's token, and a Kingdom can give up its own token.

- Add Kingdom in Config gives one command to run on a new machine, and Remove on a Castle takes a Kingdom away.
- `crystal-bridge-kingdom join` and `leave` turn a Linux or macOS machine into a Kingdom and back, with one command.

- Choose the colour of your own prompts in Config. The default is a muted purple, so blue only ever means "look here".

- The hub comes as a container image for amd64 and arm64, with token login on by default.
- The hub builds into an installable package, `@crystal-bridge/airship`, with the web app inside. `AIRSHIP_HOST` sets the address it listens on and `AIRSHIP_DATA` keeps everything in one folder.
- `pnpm demo` runs the app with a scripted world in it, with no `claude` and nothing kept.
- The Tavern knows what's waiting after a reload or on a new device.

### Changed

- Theme words: Gold for cost; Wizard, Cleric and Rogue Classes; a finished turn reads "Battle won".

### Fixed

- Background subagents stay in the Party until they finish, on both engines, and count as Side Quests on battle cards.
  A Quest whose only work is a background agent no longer idles out.

### Security

- `AIRSHIP_AUTH=token` is the hub's own login, with long-lived access tokens. It ignores identity headers, so a hub can sit behind any proxy.
- Node tokens take effect without a hub restart, and revoking one cuts that Kingdom's connection at once.
- The hub refuses to start without an allow list and node tokens, unless it is a development hub.
- `docs/SECURITY-MODEL.md` documents the trust boundaries and the identity header's limits.
