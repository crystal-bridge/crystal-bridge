# Crystal Bridge

Do all your [Claude Code](https://code.claude.com) work from one place. Crystal Bridge brings every session on every
machine, across one Claude account or several, into a single web app that works as well on your phone as on your
laptop. Each session streams into a tab; approvals and questions show up as cards you can answer from anywhere;
notifications tell you when a session needs you.

It wraps the real, unmodified `claude` CLI on each machine, under that machine's own login. It doesn't reimplement
Claude Code's agent loop, and it never touches your credentials.

![A tour of the app: the Airship and its Tavern across three Kingdoms, a Castle, a busy Quest with its party and meters, an approval leading to Battle won, the Inventory, and Split View across two Kingdoms](docs/images/demo.gif)

_A tour of the app with `pnpm demo`, a scripted world of invented Kingdoms._

## Features

- **Every machine in one app:** a tab per machine, each with its own sessions, plan usage, projects and history. Rename,
  re-colour, re-icon or hide each one per device.
- **Full sessions in the browser:** streaming replies, diff and command cards, approval and question cards, follow-ups
  that resume a stopped session, fork, close, and a permission mode per session.
- **One view of what needs you:** an overview of everything waiting on you across machines, and a dashboard per machine
  with today's totals, active sessions and recent folders.
- **Side panels:** status, context and cost meters, files changed, background tasks, and an inventory of the skills,
  commands and MCP servers a session can use.
- **Split View:** two sessions side by side, even from different machines.
- **Notifications:** desktop and Web Push, with a per-machine "Discreet" level that never shows session titles.
- **Bring sessions in:** adopt sessions you started in a terminal, and carry on from the browser.
- **A theme you can turn off:** the default dresses everything up as a 16-bit RPG; the Classic theme uses plain words.
  Words, colours and art are pluggable (`apps/web/src/theme`, `docs/THEME.md`).

## How it works

### The world

The default theme has its own words for things. Classic uses plain ones.

| Term | What it is |
|---|---|
| **Airship** | The hub every machine connects to, and the app's home page |
| **Tavern** | The room on the Airship that lists everything waiting on you, across Kingdoms |
| **Kingdom** | A machine and the Claude account signed in on it |
| **Crystal** | The agent that runs on a Kingdom and connects it to the Airship |
| **Castle** | A Kingdom's dashboard |
| **Quest** | A session |
| **Hero** | An agent: the party leader runs the Quest, and subagents join for a task |
| **Side Quest** | A background task or monitor running alongside its Quest |
| **Recruit** | Adopt a session found outside the bridge |
| **Chronicle** | History: closed Quests and search |
| **HP, MP, Gold** | Plan usage left, context left, and cost |

### The parts

Three processes:

| Process | Role | Default port |
|---|---|---|
| **Airship** (`apps/airship`) | The hub: HTTP API, WebSocket relay, SQLite event store; serves the web app | `7700` |
| **Crystal** (`apps/crystal`) | One per machine: runs `claude`, answers its permission prompts through a local MCP tool, dials the hub | `7701` |
| **Web** (`apps/web`) | The React client (a Vite dev server in development; built and served by the Airship in production) | `5173` |

Crystal runs `claude` in its documented stream-json mode, or optionally in a pseudo-terminal for the tools only
interactive sessions have (see "Interactive engine" in `docs/OPERATIONS.md`). The hub stores Claude's raw event lines
in an engine-neutral envelope.

## Is this allowed?

Yes, and it was built that way from the start. Crystal Bridge only ever runs the unmodified `claude` binary, signed in
by you, on your own machines: the use Anthropic's
[legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page allows for a personal subscription.
It never reads, copies or relays Claude credentials or tokens, and it doesn't use the Agent SDK with a subscription
login. Everything your subscription does here, it does through the same CLI you'd run in a terminal.

If you need API-key billing or want to offer it to others, read those terms first.

## Good to know

- **It is a remote control for your machines.** Anyone who can use the hub can run code on every connected machine.
  Read `docs/SECURITY-MODEL.md` before exposing it beyond your own private network.
- **At work,** check your organisation's policy first: on running agents remotely, and on keeping full session
  transcripts on a server (the hub stores them, including anything pasted into a chat; see `docs/HUB-DATA.md`).
- **The interactive engine is experimental.** It drives Claude Code's terminal UI and reads its session files, which
  the CLI documents as internal, so a CLI update can break it. The default stream engine uses the documented
  `stream-json` output.
- **No telemetry.** The web app talks only to your hub. The hub talks to your machines, to npm's public registry to
  see the latest Claude Code version (`AIRSHIP_CLI_CHECK=off` stops that), and, if you turn on Web Push, to your
  browsers' push services. Nothing about you or your sessions is sent. Fonts and art are bundled.
- **Where it runs:** the hub and Kingdoms on Linux and macOS, with Node 22 or newer; the web app in current Chrome,
  Firefox and Safari, including as an installed app on a phone. Windows is untested.
- **A personal project.** Pull requests are welcome (see `CONTRIBUTING.md`); there are no support promises.

## Quick Start

There are two ways to run it. **One machine** puts everything on your own computer and takes a couple of minutes,
which is the best way to try it. **Several machines** puts the hub on an always-on host, with a Crystal on each machine
you run Claude Code on. The hub can sit on your tailnet, or anywhere you can give it HTTPS.

### One machine

You need Node 22+, pnpm (`corepack enable`), and Claude Code installed and signed in (run `claude` once).

```sh
pnpm install
pnpm dev
```

`pnpm dev` checks your tools (`scripts/preflight.sh`), then starts all three processes on `127.0.0.1`. Open
**http://localhost:5173**. With nothing else configured there's no login and no node tokens, so keep it on
localhost.

### Several machines

The intended setup puts every machine on one [Tailscale](https://tailscale.com) tailnet, with the **Airship** on an
always-on host, published with `tailscale serve` (HTTPS), limited to your tailnet login (`AIRSHIP_ALLOWED_USERS`), with a
token per Kingdom (`AIRSHIP_NODES`).

Start the hub with the deploy script, which ships the pushed `main` over SSH:

```sh
scripts/deploy-airship.sh hub-host you@example.com    # first run sets the allowed tailnet login
```

Then add each machine from the app: open **Config**, name the new Kingdom under **Add Kingdom**, and run the command it
gives you on that machine. It needs Node 22+ and Claude Code signed in, and only outbound HTTPS: no SSH or inbound
ports. On Linux it asks for sudo once, so the Kingdom keeps running after you log out. To remove a Kingdom, use **Remove**
on its Castle, then run the command it shows on that machine. Its Quests stay as history unless you then choose
**Forget** there. Linux and macOS are supported.

#### Without Tailscale

From `v0.2.0-alpha.1`, the hub also comes as a container with its own login:

```sh
docker run -d --name crystal-bridge -p 7700:7700 -v crystal-bridge:/data ghcr.io/crystal-bridge/airship:0.2.0-alpha.1
docker exec crystal-bridge crystal-bridge-airship token add me   # shows your login token once
```

Put HTTPS in front of it (Caddy, nginx or a tunnel), because tokens travel in the clear without it. Then log in and add
Kingdoms from the app as above. The same hub runs without Docker from the release's tarball, with `AIRSHIP_AUTH=token`
and `AIRSHIP_DATA` set; see `docs/OPERATIONS.md`.

#### Pushing Crystal over SSH

If you'd rather push Crystal out from a checkout over SSH, the deploy scripts do that too:

```sh
scripts/deploy-crystal.sh node-a-host node-a hub-host  # a Linux machine: <ssh-host> <node-id> <hub-ssh-host>
scripts/deploy-crystal-macos.sh my-mac hub-host        # the Mac you run it on
```

`docs/OPERATIONS.md` covers joining, deploys that wait for running turns, rollbacks, backups, Web Push and monitoring;
`deploy/airship/airship.env.example` lists the hub's settings.

## Configuration

| Variable | Default | Used by |
|---|---|---|
| `CRYSTAL_HUB` | `ws://127.0.0.1:7700/node` | Crystal: the hub's node WebSocket |
| `CRYSTAL_NODE` | `local` | Crystal: this machine's node id |
| `CRYSTAL_TOKEN` | unset | Crystal: its node token, sent as a bearer header |
| `CRYSTAL_MCP_PORT` | `7701` | Crystal: its local port (permission tool, hooks, status) |
| `CRYSTAL_IDLE_MS` | `600000` | Crystal: stop an idle session's process after this long; the next follow-up resumes it |
| `CRYSTAL_DEFAULT_MODE` | `manual` | Crystal: permission mode for new sessions |
| `CRYSTAL_PROJECT_ROOTS` | `~/code` | Crystal: where the New Quest picker looks for repos (`:`-separated) |
| `CRYSTAL_CHROME` | unset | Crystal: `1` starts sessions with `--chrome` |
| `CRYSTAL_ENGINES` | `stream` | Crystal: `stream,interactive` enables the interactive engine |
| `CLAUDE_BIN` | `claude` | Crystal: the CLI it runs |
| `AIRSHIP_PORT` | `7700` | Airship: its HTTP/WebSocket port |
| `AIRSHIP_HOST` | `127.0.0.1` | Airship: the address it listens on; anything but loopback needs `AIRSHIP_AUTH=token` |
| `AIRSHIP_DATA` | unset | Airship: one folder for the database, tokens, keys and backups |
| `AIRSHIP_DB` | `./airship.db` | Airship: the SQLite file |
| `AIRSHIP_AUTH` | `tailscale-serve` when `AIRSHIP_ALLOWED_USERS` is set | Airship: how it knows who a request is from: `tailscale-serve` or `token` |
| `AIRSHIP_TOKENS` | next to the database | Airship: the access-token file for `AIRSHIP_AUTH=token` |
| `AIRSHIP_ALLOWED_USERS` | unset | Airship: tailnet logins allowed to use the app (`Tailscale-User-Login`); required unless `AIRSHIP_DEV=1` |
| `AIRSHIP_NODES` | unset | Airship: the node-token file; required unless `AIRSHIP_DEV=1` |
| `AIRSHIP_DEV` | unset | Airship: `1` starts a development hub open (no allow list or node tokens); `pnpm dev` does this itself |
| `AIRSHIP_VAPID_PATH` | next to the database | Airship: Web Push keys |
| `AIRSHIP_CLI_CHECK` | on | Airship: `off` stops it asking npm for the latest Claude Code version |

## Development

- `pnpm test`, `pnpm typecheck`, `pnpm format` (Prettier).
- `pnpm smoke`: with `pnpm dev` running, starts a real session in a throwaway repo, approves its permission prompt and
  checks it ran.
- `pnpm demo`: the app with a scripted world in it, for screenshots and a look around. It starts a throwaway hub and
  three invented Kingdoms over the real protocol. No `claude` runs, nothing is kept, and Approve works.
- `AGENTS.md` holds the working rules (`CLAUDE.md` imports it); `docs/` the operations guide and theme.

## Licence

Crystal Bridge is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are
trademarks of Anthropic.

Code: MIT (`LICENSE`). The Hero sprites in `apps/web/public/heroes` are LPC art under their own licences
(`apps/web/public/heroes/LICENSE-ART.md`, `CREDITS.csv`). Bundled third-party packages and fonts (SIL Open Font
License) are listed with their licence texts in `THIRD_PARTY_NOTICES.md`, regenerated with `pnpm notices`;
`REUSE.toml` says which licence covers which paths.
