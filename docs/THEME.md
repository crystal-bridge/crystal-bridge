# The theme: words, looks and rules

Crystal Bridge should feel familiar to anyone who uses Claude Code, with game names on top. Every themed name maps
one-to-one onto a Claude concept, and the UI shows the plain term too (a tooltip or subtitle), so the theme adds
flavour and never hides what something is.

## Rules

- **The theme is pluggable.** Themed words live in one module (concept → themed and plain term), visual tokens in one
  stylesheet, and art in a theme pack with its own credits and licence file. A plain "Classic" theme must stay a
  drop-in swap, so forks and workplaces can turn the game names off.

- **A blend, not a costume.** A modern, neutral base with retro touches. The classic blue menu window is an accent for
  things that need attention (approval cards, dialogs), not the whole UI. The side panel's game sections (Party,
  Stats, Expedition) wear it only as a small plate on their titles, each in its own hue (blue, crimson, green), with
  plain bodies, so a full blue window still means "this needs you" (#24).
- **Readability first.** People read a lot in a Quest, so anything read at length stays in a clean UI font and code
  in a monospace font; the pixel display font is for what you glance at or pick. See *Type and controls* below.
- **Plain words where it matters.** Errors say what broke in plain words first; flavour text comes after. Allow and
  Deny stay readable even when the card looks like a battle menu. Fork and worktrees keep their plain names.
- **The prompt box** (#15) is one rounded field: the text box starts one line tall and grows to five before it
  scrolls; under it, a bar of settings for what you send next (Permission Mode now, attachments and effort later) and
  one round button at the end: **Stop** while a turn runs and the box is empty, **Send** otherwise (mid-turn it
  queues), **Run** for a Command Rune. Selects there wear the theme (icon, display-font value, chevron) over the
  browser's own select, so the phone's native picker still opens.
- **Opt-in complexity.** Show what you can act on now (active Quests, things waiting on you). History and detail are
  one or two clicks away and collapsed by default.
- **Sprites are small and tasteful.** They never cost screen space or readability.

## Type and controls

Decided in #18. The test for each piece of text: is it read at length, or glanced at and picked?

- **Read at length stays plain.** Chat, the prompt box's text, tool output, diffs, search results, help text and
  anything multi-line use the sans face (Atkinson Hyperlegible). Never the display font.
- **Glanced at or picked wears the theme.** Field labels (`.cb-label`), section titles, select values
  (`ThemedSelect`), plates, badges, Stats labels and the wordmark use the display face (Jersey 15) at sizes where
  it stays crisp (about 1rem and up).
- **Mono means a literal value.** Paths, branches, commands and code use JetBrains Mono, the typed value as well as
  its placeholder (the Project field).
- **Controls are themed; pickers stay native.** A select wears the theme's face (`ThemedSelect`: icon, display-font
  value, chevron) over the browser's own select, which opens the native picker (the better UI on a phone). Build a
  custom list only where it needs icons or rich rows (the project picker, slash suggestions). Short text fields use
  the field frame (`.cb-field`), checkboxes the accent colour (`.cb-check`).
- **One frame per surface.** The prompt box, fields and selects share the `--prompt-*` tokens in theme.css; menu
  windows and plates share the `--color-window-*` ones. No one-off borders or colours for a new control.
- **Short choices sit side by side.** Values that are a word or two (Permission Mode, Engine) go in one row, in the
  prompt box's bar where they set what's sent next.

## Words

| Theme | Claude concept | Notes |
|---|---|---|
| **Crystal Bridge** | the app | The name of the game. |
| **Airship** | the hub, and the app-wide Home | The app-bar logo goes here. |
| **Tavern** | what's waiting on you, across Kingdoms | A room on the Airship; respects hidden and Discreet Kingdoms. |
| **Kingdom** | a node and its Claude account | Its dashboard is the **Castle**. |
| **Quest** | a session | |
| **Hero** | an agent | The session's main agent is the **party leader**; subagents are Heroes who join for a task and leave. The party is whoever is active, so it isn't declared. |
| **Class** | agent type | Matched from the agent's name by role; see Hero Classes below. Gives a Hero its look. |
| **Side Quest** | background task or monitor | Runs alongside its Quest. |
| **Chronicle** | history: closed Quests, search | Collapsed by default. |
| **Recruit** | adopt a CLI session found outside the bridge | |
| **Scroll** | a file of the Quest, read-only in the viewer | Opened from Loot, tool cards and file names in replies. |
| **Summon** | a worker machine (P3) | Calling a Summon sends it a job; the result comes back. |
| **Config** | settings | The app-bar gear menu. |

### Inventory

Grouped by how a thing behaves, not where it came from, so new kinds slot in. An unknown kind lands in Items.

| Category | Behaviour | Today |
|---|---|---|
| **Spells** | Cast, with an optional target or argument; shapes how a Hero acts | Skills |
| **Items** | Use once and it's done | Slash commands (`/compact` is an Ether) |
| **Equipment** | Always on; grants abilities; shows whether it works | MCP servers, plugins |
| **Abilities** | Passive triggers that fire by themselves; read-only | Hooks (collapsed by default) |

When a Hero uses something from the Inventory, the chat says so in one line, with a verb per category: "Paladin
**casts** deploy!" (Spells), "**uses**" (Items), "**wields**" (Equipment). The skill's own text stays folded under
it. Words in `useLine` (`apps/web/src/theme/words.ts`); Classic: "Used skill: deploy".

### Stats

HP and MP bars drain in five colour steps, green when full through yellow and orange to red near empty
(`--meter-1` to `--meter-5` in theme.css); the percentage stays in text, so colour is never the only signal.

| Theme | Claude concept |
|---|---|
| **HP** | the Kingdom's plan usage left in its five-hour window, as a draining bar; full again when it resets (*Resting at the Inn*). Shared by the Kingdom's Quests |
| **MP** | context left in the window, as a draining bar |
| **Gold** | cost, one coin per US cent (118 Gold is $1.18), grouped by locale; a tiny info icon shows the dollars (hover, focus or tap). Classic: dollars |
| **Command Rune** | shell mode: a follow-up starting with `!` on an interactive Quest (the prompt box turns rose) |
| **Loot** | files changed |
| **Expedition** | where and how a Quest runs (Kingdom, project, branch, model, mode): the side panel's section under Stats |
| **Resting at the Inn** | plan usage resetting (flavour text, not a label) |

### Battle results

Under each turn's result, a one-line card folded by default: **Battle won**, **Retreat** (you stopped it) or **KO**
(it failed), with time, Gold and files changed; open it for tokens, Loot, the Heroes sent out (as their Classes) and
Side Quests started. The latest turn of a Quest between turns shows its card open, with the party leader's pose, so
the chat ends on how it went, and a line under it says **The Quest goes on · awaiting your orders**, so a finished
turn never reads as the end; a new message folds it. When a Quest is closed, an open **Quest complete** card sums every turn, with the MP its last
request used and the party leader's victory pose. Classic theme: "Turn finished", "Turn stopped", "Turn failed",
"Session summary". Derived in `apps/web/src/battle.ts` from the events already stored.

### Step words

While the party leader works, the Party card names what it's doing with a word for that kind of step, picked per
step from a small set: Heeding (reading your message), Pondering/Plotting (thinking), Scribing (writing a reply),
Studying/Scouting (reading files), Forging/Inscribing (editing), Casting/Invoking (running a command),
Tracking/Hunting (searching), Scrying (the web), Rallying (sending out a subagent), Parleying (asking you),
Charting (planning), Awaiting orders (waiting for you), Wielding (any other tool). The plain meaning is the tooltip.
They live in `apps/web/src/theme/words.ts` (`stepWord`); the Classic theme uses plain verbs.

### Hero Classes

Picked by the owner on 2026-10-29 from the "Hero Class Audition". Recipes and matching keywords are data in
`tools/sprites/classes.json`, so a fork can change them without code.

| Class | Look | Covers | Working |
|---|---|---|---|
| **Paladin** | Holy Knight: plate, blue cape, sword and shield | the party leader (main agent), security agents | Smite |
| **Wizard** | Classic: navy robe, pointed black hat, shadow face, staff | general-purpose and builder agents; anything unmatched | Cast |
| **Cleric** | Hooded: white hooded robe, staff | reviewers, verifiers, testers, debuggers | Heal |
| **Ranger** | Hooded archer: green hood, leather, bow | research, web and docs agents | Shoot |
| **Rogue** | Shadow: dark hood, tattered cape, dagger | Explore and search agents | Sneak |
| **Sage** | Elder: old man in purple, starry hat, staff | Plan and architect agents | Scan |

### Hero states

| State | Meaning | LPC animation |
|---|---|---|
| Resting | idle | walk / idle |
| Casting | working | cast |
| "!" | needs you | emote |
| Battle won | turn done | |
| KO | failed | hurt |

## Art

**Kingdom banners** ("Kingdom Banner Audition", 2026-10-29): each Kingdom has an icon and a banner colour, and tabs
show the colour as an underline, a tint or a pennant. These are the user's choices in Config, synced to all their
devices, never built-in defaults; a Kingdom with no choice gets a stable look from its id. The eight icons are
original 16×16 pixel art drawn for Crystal Bridge (no licence strings); icons and colours are data in
`apps/web/src/theme/kingdomIcons.ts` (source grids in `tools/sprites/kingdoms/icons.py`), so adding one is a list
entry.

From the "Sprite Party Audition" comparison (2026-10-28):

- **Heroes:** LPC, built with the Universal LPC Spritesheet Generator. 64×64, layered (body, outfit, hat, weapon) with
  palette variants, so Class sets outfit and weapon and each Hero gets its own palette. Licences vary per layer
  (CC-BY-SA, GPL, OGA-BY, CC-BY, CC0), and a layer listing several may be used under any one; the pack uses only
  layers that offer an attribution-only one (OGA-BY, CC-BY or CC0). The generated `CREDITS.csv` ships with the art.
- **The art pack** the app serves is `apps/web/public/heroes`, built from `tools/sprites/classes.json` by
  `tools/sprites/build_pack.py`: one folder per Class, a `manifest.json` the app reads at runtime (Classes, keywords,
  leader, fallback, frame sizes), and `CREDITS.csv` plus `LICENSE-ART.md`. A fork swaps the whole folder to change
  the art; the Classic theme (`VITE_CB_THEME=classic`) draws no Heroes.
- **World map and monsters:** Ninja Adventure (CC0).
- **Icons** ("Quest UI Audition", 2026-10-30): Game-icons (CC BY 3.0, credited per artist) for themed concepts
  (Inventory, Spells, Items, Abilities, Close, Permission Mode, HP, MP, Gold) and Phosphor's filled weight (MIT) for
  plain UI (Fork, Split, side panel, Send, Stop, Attach) and Equipment's sword. `apps/web/src/theme/iconSources.ts`
  names each icon's pack, icon and artist; `pnpm icons` copies the drawings into `iconData.ts`, so the packs are dev
  dependencies only. Each icon keeps its own colour (`.cb-icon-<name>` in theme.css).
- Time Fantasy was ruled out: its licence forbids redistribution.
- **For open-sourcing:** the art ships as its own pack with `CREDITS.csv` and `LICENSE-ART.md`, separate from the
  code's licence, and the in-app Credits name each layer's licence. `build_pack.py` refuses a layer that is
  share-alike only (CC-BY-SA or GPL with no attribution-only option); pick another. Hero Class matching (agent-name keywords → Class) should be data a user can edit.

## Later ideas (low priority)

- **A pointless levelling system:** Heroes, Kingdoms or Crystal Bridge itself earn experience and levels from use.
  Arbitrary on purpose; a rough, fun measure of usage over time.
