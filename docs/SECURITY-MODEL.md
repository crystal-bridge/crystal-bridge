# Security model

Crystal Bridge is a remote control for coding agents. Whoever can use the hub can make every connected Kingdom read,
write and run code as the user Crystal runs as, within each Quest's permission mode. Treat access to the hub like SSH
access to all of those machines at once. This page says what is protected, how, and what isn't.

## The parts and who talks to whom

```text
browser ──HTTPS──▶ tailscale serve ──▶ Airship (hub) on 127.0.0.1:7700 ◀──WSS + node token── Crystal (each Kingdom)
                    sets Tailscale-User-Login                                                 │
                                                                                              ├─ runs `claude` under the
                                                                                              │  machine's own login
                                                                                              └─ 127.0.0.1 port: the MCP
                                                                                                 permission tool and hooks
```

| Boundary | How it is protected |
| --- | --- |
| Browser → hub, `AIRSHIP_AUTH=token` | The hub's own login. Long-lived access tokens (256 random bits, stored as SHA-256 in `AIRSHIP_TOKENS`) are sent as a bearer header or traded for an `HttpOnly`, `SameSite=Strict` cookie, marked `Secure` over HTTPS. It reads no identity header, so any proxy can sit in front. The app shell loads without a login and holds no data; `/api` and `/client` stay closed. Serve it over HTTPS: the token and cookie travel in the clear otherwise. A hub with no logins starts locked: `POST /api/setup` trades a one-time code for the first login. The code has 128 random bits, is shown only in the hub's logs, is kept in memory, and stops working once any login exists. The routes anyone can reach without a login (`/api/login`, `/api/setup`, `/api/join`, `/api/leave` and `/node`) are rate-limited per address. Behind a proxy that's one shared address, so a flood can delay new logins, but people already logged in aren't affected. A removed token stops working for requests at once, and an open `/client` socket is re-checked at each heartbeat and closed within 30 seconds. |
| Browser → hub, `AIRSHIP_AUTH=tailscale-serve` | `tailscale serve` (HTTPS, tailnet only) adds `Tailscale-User-Login`; the hub serves only logins in `AIRSHIP_ALLOWED_USERS`. The hub listens on 127.0.0.1 only, so nothing else on the network reaches it directly. |
| Other sites → hub | A browser brings a page's requests the login too, so the hub refuses `/client` and anything that changes state when it comes from another site. It reads `Sec-Fetch-Site`, then `Origin` against `Host` or `X-Forwarded-Host`, so a proxy that rewrites `Host` over HTTPS changes nothing. |
| Kingdom → hub | Each Kingdom dials out with its own bearer token. The hub stores only a SHA-256 of each token (`AIRSHIP_NODES`), compares in constant time, re-checks it at each heartbeat, and lets a node read and write only its own sessions and speak only for them. A second Crystal on the same id gets no say while the first is answering. |
| New Kingdom → hub | An allowed user makes a one-time join code for a new name. `POST /api/join` trades it for that node's token, needs no login, and only exists to do this. A code has 128 random bits, lasts 10 minutes, works once, is kept as a hash in memory, and can't be made for a name that already has a token, so it can't take over a Kingdom. |
| Crystal → `claude` | The unmodified CLI under the machine's login. Crystal never reads, copies or relays Claude's credentials. It takes its node token out of its own environment once read, so nothing it starts inherits it: not `claude`, and not the git it runs in a Quest's folder, where a repo's hooks and config are the Quest's to write. The token is still in `crystal.env`, mode 0600, which a Quest can read because it runs as the same user. |
| `claude` → Crystal | The permission tool and hooks call Crystal on 127.0.0.1. Approvals are decided by the user in the web app; Crystal only relays them. The port has no token: it refuses web pages by their `Origin` and `Host` headers, but any local user can reach it. |
| Kingdom → Summon | The Kingdom connects by its own `ssh`, only to machines in `CRYSTAL_SUMMONS` and those it still has Casts running on, and keys stay on the Kingdom. The hub never connects to a target. It holds only the Summon's name, which is the SSH host name unless you give it a `name=`. A Cast runs with the SSH user's full rights: it's not a sandbox. See [Summons](SUMMONS.md#security). |
| Kingdom → Scout | A Scout's collector runs on its schedule as Crystal's user, with the login environment and that user's full rights: it's not a sandbox. Only what's written in a Scout's folder on the Kingdom says what runs; the hub can ask for a run of a Scout that's already there, by name, or for one of the actions its `scout.json` declares, on items the hub stored, or for a draft of one of its Quest actions as a Patrol ("Patrol this", which reads the prompt file and fills the project, and starts nothing), and nothing more. An action's prompt file must sit inside the Scout's folder. The collector never gets the node token, and its `state` folder is created at 0700. The items it prints and the end of its stderr go to the hub and are stored there, so keep secrets out of both. Item text comes from other people and is treated as untrusted: a Quest's prompt carries it in a block marked untrusted, apart from the template's instructions, and a project folder filled from it must be an existing folder with no `..`. See [Scouts and Boards](SCOUTS.md). |
| Kingdom → Patrol | A Patrol runs on its schedule as Crystal's user, with that user's full rights. A script Patrol runs its command with no approval at all, so it comes only from a file written on the Kingdom: the app can save Quest Patrols only, and never over a script Patrol's folder. A Quest Patrol's Quest asks for approvals in its permission mode like any Quest; a prompt nobody answers within its `waitForYou` is denied and the run ends. A script never gets the node token. Its stdout and stderr ends go to the hub and are stored there. `CRYSTAL_PATROLS_FROM_APP=off` stops the app creating or editing any Patrol on that Kingdom. A Patrol made with "Patrol this" keeps a Board item's text in its prompt, marked untrusted, and replays it on every run with nobody watching: its permission mode is the only limit on what that text can steer, so prefer `manual` or `plan` for items others wrote. See [Patrols](PATROLS.md). |
| Hub at rest | SQLite on the hub's disk holds every event: prompts, replies, tool inputs and outputs, anything pasted. Nightly backups copy it. The hub keeps the database, its `-wal` and `-shm`, and each backup at 0600 whatever the umask, and tightens existing ones when it opens them or next backs up. It's plain file permissions, not encryption. |
| Hub → phone | Web Push payloads are encrypted end to end to each browser; Discreet and Off levels keep titles and text out of them. |
| Agent text → browser | Replies and repository files are shown as markdown, and an image loads with no click, so one could carry data out in its address. A remote image shows as a link instead, and only `data:` and same-origin images draw. Every hub response also sends `Content-Security-Policy: img-src 'self' data: blob:; frame-ancestors 'none'`, except the Library's own answers, which send a stricter policy of their own (see [The Library](#the-library)). |

It also refuses `AIRSHIP_HOST` on anything but loopback unless `AIRSHIP_AUTH=token`, because anyone who could reach it directly could send the identity header themselves.

The hub refuses to start without a login method and a node token file. That takes `AIRSHIP_AUTH=token` or an allow list
(`AIRSHIP_ALLOWED_USERS`), and `AIRSHIP_NODES` or `AIRSHIP_DATA`. A development hub (`pnpm dev`, or `AIRSHIP_DEV=1`) is
exempt, and with no login it stays on loopback.

## The identity header

On `AIRSHIP_AUTH=tailscale-serve`, the hub learns who a browser user is from the `Tailscale-User-Login` header. That is
safe with `tailscale serve` in front, because it sets the header on every request it proxies, and nothing but local
processes can reach the hub's loopback port.

It is **not** safe behind another reverse proxy (nginx, Caddy, a tunnel) that forwards a header the browser sent:
then anyone who reaches that proxy can claim any login. The hub can't tell the difference, since every request
arrives from loopback either way. So in this mode put **only** `tailscale serve` in front of the hub, or a proxy that
deletes any incoming `Tailscale-User-Login` before setting its own. For any other proxy use `AIRSHIP_AUTH=token`, the
hub's own login, which reads no identity header.

## What a compromise of each part gives an attacker

| If an attacker has… | They can… |
| --- | --- |
| An allowed login (or a spoofed header, above) | Start Quests and approve their actions on every Kingdom: run commands as each Kingdom's user. Read every stored conversation. Save Quest Patrols that keep starting Quests on a Kingdom after that login is removed. |
| Text a Quest reads, such as an issue or a web page, that steers it | Rename that Quest, since naming itself never asks: for example to look like another Quest you expect a prompt from. It can't rename a Quest on another Kingdom or one you renamed, and an approval card still shows the real tool and input. A name is one line of plain text, up to 120 characters. |
| Text a Quest reads, such as an issue or a web page, that steers it | Leave you an Errand, since leaving one never asks, for example one with a harmful command in it. The app copies a command and never runs one, and renders no HTML or scripts from the body. Read a command before you run it, as you would one in the chat. A Quest can't edit, tick or remove an Errand, and leaves at most 10 a turn. |
| Text a Quest reads, such as an issue or a web page, that steers it | Record a misleading Deed, since recording one never asks. A Deed is plain text in the feed (no Markdown, links or HTML), one line and a short detail, at most 3 a turn. At Close, the digest carries text the Quest read; the call that reads it is marked to treat it as data, loads no settings, and has no tools and no MCP servers, so it can only write Deeds. |
| A Quest on a Kingdom with Summons | Run commands on every machine in that Kingdom's `CRYSTAL_SUMMONS`, as its SSH user, through `summon` or by using the Kingdom's SSH key directly. To limit that, give the Kingdom a restricted key or a limited user on the target. |
| Text a Quest reads, such as an issue or a web page, that steers it | Write a Tome that steers a later Quest, since a Quest on a Kingdom with a Library writes files there with its ordinary tools. Each Quest's prompt says text from Tomes is reference material, but a Tome can carry an injection from one Quest to the next, as any file can. With `CRYSTAL_LIBRARY_QUESTS=folder` the Quest reaches the folder without asking; without it, its permission mode decides. |
| A Kingdom that lies in its answers | Show you wrong Tomes, or none, in its own Library. It can't pick how a file is served: the hub sets the content type from the file's extension and sends its own headers on every Library answer. |
| A hostile HTML Tome, which a Quest or a person put in a Library | Run script in a frame with an opaque origin: it can't read the app's storage, cookies or login, call the hub's API, or open a popup. It can still contact other sites without a click, through WebRTC (every browser tested) and, in WebKit, preconnect links, and can send what the page contains, that you opened it and your IP address. Following a link in it, or its own navigation, can carry the same in an address. It can't reach the page's host as the hub: opened at its own address, it downloads. |
| A node token | Pose as that one Kingdom to the hub: see the Quests started for it, send fake events into its sessions. Not reach other Kingdoms' sessions. The hub re-checks a token at each heartbeat, so replacing one with `scripts/airship-node-add.sh` (hubs run from a checkout) closes the old token's live link within 30 seconds, and the Kingdom needs the new token in `crystal.env` by then. **Remove** on the Castle (`DELETE /api/nodes/<id>`) revokes the token and cuts its connection at once, and is how to replace one on a packaged hub: Remove, then add the Kingdom again. None of this needs a hub restart. |
| A shell on a Kingdom as Crystal's user | Everything that user can already do, including running `claude`, reading the node token from `crystal.env` and answering Crystal's local permission port. A Quest's commands run as that user too. Crystal adds no protection inside one user account. |
| A shell on a tailnet device owned by an allowed user, on `tailscale-serve` | Reach the hub as that login, with no token, because `tailscale serve` names the device's owner on every request. That includes a Quest's shell on a Kingdom owned by that login: it can start Quests and approve actions on every Kingdom, whatever its own permission mode. To stop this, tag your Kingdoms: a tagged device gets no identity header, so the hub refuses it as a user, and `/node` keeps working on its token as long as your tailnet policy lets the tag reach the hub. |
| Write access to a Kingdom's scouts folder | Run any command as Crystal's user on the next tick, by adding or editing a Scout. That's the same user's own folder, so it adds nothing to a shell as that user, but keep the folder's permissions tight. |
| Write access to a Kingdom's patrols folder | The same as for the scouts folder: run any command as Crystal's user on the Patrol's schedule. |
| Another user account on a Kingdom | Reach Crystal's local port, which checks no token: list busy Quests and, with one's id, raise approval cards, rename the Quest, leave Errands, record Deeds, or use the `summon` tool as that Quest. Run a Kingdom on a machine whose local users you trust. |
| The hub's disk or a backup | Every stored conversation, including any secret ever pasted into one. |
| A shell on the hub host | All of the above for the hub, plus serving a modified web app to users. |
| Control of the hub, on self-updating Kingdoms | Name a newer real release, which those Kingdoms would install. Not run its own code that way, and not move a Kingdom to an older release. It still has every power of an allowed login. |

## The Library

A Kingdom serves the folder named by `CRYSTAL_LIBRARY_DIR` to the hub, and reads and writes only inside it. The
[Library guide](LIBRARY.md) describes the feature; these are its rules.

- **Who can use it.** Anyone who can use the hub can read and edit every Kingdom's Library, as they can already start a
  Quest there that reads the same files.
- **The folder.** Crystal makes it with mode 0700 on start.
- **Paths are checked twice.** First by their text, before the disk is touched, so a network path never makes Windows
  reach out. Crystal refuses an empty or absolute path, a leading `/` or `\`, a `..` step, a NUL, a `:` anywhere
  (`x:y.md` names an alternate data stream on Windows), Windows device names (`CON`, `NUL`, `COM1` and the like), and
  names that end in a dot or a space. Then it resolves the real path, with symlinks followed, and refuses anything
  outside the Library's real path.
- **What is reachable.** Folders, Markdown (`.md`), HTML (`.html`, `.htm`) and images. Names that start with a dot (in
  any letter case), `node_modules` and anything the top-level `.gitignore` excludes are left out of every read, write
  and listing, not only the listing.
- **Writes are narrower than reads.** They take `.md` files only. Crystal writes a temporary file with a random name,
  created exclusively (`O_EXCL`), then renames it into place and checks the result's real path again. It never writes
  over a symlink. So the app can't change `.git/hooks`, Obsidian's settings or plugins, or a file outside the Library.
- **One answer for every refusal.** A refused path and a missing file both get "not in the Library", so a refusal
  never says what exists.
- **Quests.** A Quest's permission mode decides whether it may touch the folder. `CRYSTAL_LIBRARY_QUESTS=folder` adds
  the folder to every Quest, including the unattended Quests that Scouts and Patrols start, so enable it only where
  every Quest, including one working on an untrusted repository, may read the Library and write any file type there.

### The hub's part

The Kingdom confines paths. The hub decides how each answer is served, since a Library holds files other people wrote.
Its routes sit under `/api/nodes/:node/library` (the list, `tome` to read and write, `backlinks`, `file` for images
and `page` for HTML Tomes). Each needs a login like any `/api/` route, even when the app shell loads without one (`AIRSHIP_AUTH=token`).

- **Headers on every answer.** A `Content-Security-Policy` with `sandbox`, which replaces the hub's global one;
  `X-Content-Type-Options: nosniff`; and `Cross-Origin-Resource-Policy: same-origin`. Refusals the hub gives before
  a route runs carry them too: malformed JSON, a body over the limit, a request from another site or without a login.
- **Content types come from the hub.** It maps the file's extension to a type and never takes one from the Kingdom.
- **SVG** is sent with `sandbox; default-src 'none'; style-src 'unsafe-inline'`, so a picture can't run script or
  load anything, even when opened directly.
- **Images** are read two at a time per Kingdom. A read waits at most 15 seconds for a slot, then at most 15 seconds
  for its answer, so a page of images can't tie up the link.
- **HTML Tomes** are served as a page only into the app's own frame: the request must carry `Sec-Fetch-Dest: iframe`
  and `Sec-Fetch-Site: same-origin`. Any other request, such as a pasted address, gets the file as a download. The page
  carries `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src
  data: blob:; frame-ancestors 'self'`. The frame in the app has `sandbox="allow-scripts"` and no
  `allow-same-origin`, so the page runs with an opaque origin.
- **The Mermaid frame.** Each diagram is drawn in a page at `/sandbox/mermaid-frame.html` (also reachable as
  `/mermaid-frame.html`), which has its own sandbox policy and is framed by the app only.
- **`/assets/*` allows any origin.** It answers `Access-Control-Allow-Origin: *`, because the Mermaid frame has an
  opaque origin and loads its module scripts across origins. Those files are the app's public code, which the app shell
  already serves with no login, so this exposes nothing that wasn't open.
- **Change notices** reach only the browser tabs that sent `library-watch`, so a tab that never opened the Library
  hears nothing about it.

**What an HTML Tome can still do.** The sandbox stops background requests, reading the app and popups. It doesn't stop
a page from contacting other sites: WebRTC's STUN requests work in Chromium and WebKit, and WebKit also opens a
connection for a preconnect link. A page can also navigate its own frame, or you can follow a link in it. So a page can
send another site what it contains, that you opened it and your IP address. It can't read the app, the Kingdom's other
files or anything you typed. The owner chose to keep scripts in HTML Tomes and say so, rather than strip them: the
badge on the frame says it. The browser tests record the two gaps instead of failing on them. See
[the Library guide](LIBRARY.md#open-the-sealed-pages-html-tomes) and, to run them, [Operating](OPERATIONS.md#the-rules).

## Self-updating Kingdoms

The hub tells a Kingdom only which version to run. That version has to fit a strict pattern, since it becomes part of a URL
and a folder name, and it has to be newer than the running one. The Kingdom fetches the package from this project's
GitHub Releases, then checks the attestation itself: Sigstore's signature, whose root comes through Sigstore's own
TUF repository, on a certificate naming `release.yml` in this repository at that version's own tag, over a statement
naming that exact file and digest. So one release can't pass as another, and the hub's package can't pass as the
Kingdom's. Nothing the hub says is part of the proof. Where the attestation came from doesn't matter either: the
release carries a copy, GitHub's API is the fallback, and both have to pass the same check.

A packaged hub updates itself the same way, through a separate root service that checks the hub's tarball against
the same workflow identity and only moves forward. The hub, which runs as its own user, only names the release it wants
in its data folder. The updater reads that request without following links, and writes nothing there: its status goes in
a folder only root writes. So a hub that was taken over can ask for no more than a genuine, newer release of the hub's
own package ([Updating the hub from the app](./OPERATIONS.md#updating-the-hub-from-the-app)). As with
`deploy-airship-package.sh` and `join`, that package's dependencies come from npm at install time, and their install
scripts run, here as root; the next point covers them.

What this doesn't cover:

- **Who can push a release tag.** Whoever can run the release workflow can publish a release that passes. The workflow
  refuses a tag that isn't on `main` or fails the tests, but it reads that check from the tagged commit, which can leave
  it out, so only a rule on who may push tags closes this. Edge tags are the exception: the Publish workflow pushes one for each merge to `main`
  ([Releases](./OPERATIONS.md#releases)), so that rule leaves them out, and anyone who may push to the repository could
  push one. An edge build is a pre-release that only hubs following `main` take. npm's trusted publisher checks the
  workflow's file name, not the tag, so the release workflow's `npm` job runs in a GitHub environment whose required
  reviewer is the owner: no run reaches npm, an edge tag's included, until the owner approves it
  ([Releases](./OPERATIONS.md#releases)).
- **Dependencies.** The proof covers this project's package. `npm install` resolves its dependencies from npm at
  install time, by the ranges in the package, as `join` does. Install scripts are off, but a dependency's code still runs.
- **The first install.** `join` runs through `npx`, from npm or a release's URL, and verifies nothing itself. The npm
  packages are the release's attested tarballs, and from the first release after 0.7.0 the release workflow publishes
  them with npm's own provenance (0.7.0 was published by hand and has none), but `npx` doesn't check either;
  `gh attestation verify` on the release's tarball does, before you run it.

## What is out of scope

- A Kingdom user account that is already compromised (Crystal runs as that user and trusts it).
- Malicious allowed users: everyone on the allow list is fully trusted.
- The agent's own decisions within its permission mode. Pick the mode per Quest; `auto` lets it act without asking.
- Supply-chain attacks on dependencies (mitigated by a lockfile, Dependabot and CI scans, not prevented).

## Hardening checklist

1. On `tailscale-serve`, put nothing else in front of the hub, and set `AIRSHIP_ALLOWED_USERS` to the fewest logins that
   need it. On token login, serve the hub over HTTPS only, with one token per person or device.
2. One token per Kingdom; remove a Kingdom's token when you retire it.
3. Restrict the hub's disk and its backups like you would a password store: they hold full transcripts.
4. Don't paste secrets into chats. If you did, rotate the secret: deleting a Quest leaves copies in the backups until
   they rotate out ([what the hub stores](./HUB-DATA.md)).
5. Run each Kingdom's Crystal under a user that has only the access its Quests need.
6. Use Discreet or Off notifications on shared or lock-screen devices.
7. On a tailnet, tag your Kingdoms, so a Quest's shell can't use the hub as its owner's login.

Report problems privately: see [`SECURITY.md`](../SECURITY.md).
