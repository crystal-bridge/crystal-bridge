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
| Browser → hub, `AIRSHIP_AUTH=token` | The hub's own login. Long-lived access tokens (256 random bits, stored as SHA-256 in `AIRSHIP_TOKENS`) are sent as a bearer header or traded for an `HttpOnly`, `SameSite=Strict` cookie, marked `Secure` over HTTPS. It reads no identity header, so any proxy can sit in front. The app shell loads without a login and holds no data; `/api` and `/client` stay closed. Serve it over HTTPS: the token and cookie travel in the clear otherwise. A hub with no logins starts locked: `POST /api/setup` trades a one-time code for the first login. The code has 128 random bits, is shown only in the hub's logs, is kept in memory, and stops working once any login exists. The routes anyone can reach without a login (`/api/login`, `/api/setup`, `/api/join`, `/api/leave` and `/node`) are rate-limited per address. Behind a proxy that's one shared address, so a flood can delay new logins, but people already logged in aren't affected. |
| Browser → hub | `tailscale serve` (HTTPS, tailnet only) adds `Tailscale-User-Login`; the hub serves only logins in `AIRSHIP_ALLOWED_USERS`. The hub listens on 127.0.0.1 only, so nothing else on the network reaches it directly. |
| Kingdom → hub | Each Kingdom dials out with its own bearer token. The hub stores only a SHA-256 of each token (`AIRSHIP_NODES`), compares in constant time, and lets a node read and write only its own sessions. |
| New Kingdom → hub | An allowed user makes a one-time join code for a new name. `POST /api/join` trades it for that node's token, needs no login, and only exists to do this. A code has 128 random bits, lasts 10 minutes, works once, is kept as a hash in memory, and can't be made for a name that already has a token, so it can't take over a Kingdom. |
| Crystal → `claude` | The unmodified CLI under the machine's login. Crystal never reads, copies or relays Claude's credentials, and keeps its node token out of the sessions' environment. |
| `claude` → Crystal | The permission tool and hooks call Crystal on 127.0.0.1. Approvals are decided by the user in the web app; Crystal only relays them. |
| Kingdom → Summon | The Kingdom connects by its own `ssh`, only to machines in `CRYSTAL_SUMMONS` and those it still has Casts running on, and keys stay on the Kingdom. The hub never connects to a target and never holds its address, only the Summon's name. A Cast runs with the SSH user's full rights: it's not a sandbox. See [Summons](SUMMONS.md#security). |
| Hub at rest | SQLite on the hub's disk holds every event: prompts, replies, tool inputs and outputs, anything pasted. Nightly backups copy it. |
| Hub → phone | Web Push payloads are encrypted end to end to each browser; Discreet and Off levels keep titles and text out of them. |

It also refuses `AIRSHIP_HOST` on anything but loopback unless `AIRSHIP_AUTH=token`, because anyone who could reach it directly could send the identity header themselves.

The hub refuses to start without both an allow list and a node token file, unless it is a development hub
(`pnpm dev`, or `AIRSHIP_DEV=1`), which stays on 127.0.0.1.

## The identity header

The hub learns who a browser user is from the `Tailscale-User-Login` header. That is safe in the supported setup,
because `tailscale serve` sets the header on every request it proxies, and nothing but local processes can reach the
hub's loopback port.

It is **not** safe behind another reverse proxy (nginx, Caddy, a tunnel) that forwards a header the browser sent:
then anyone who reaches that proxy can claim any login. The hub can't tell the difference, since every request
arrives from loopback either way. Until built-in login exists (tokens, then OIDC), put **only** `tailscale serve` in
front of the hub, or a proxy that deletes any incoming `Tailscale-User-Login` before setting its own.

## What a compromise of each part gives an attacker

| If an attacker has… | They can… |
| --- | --- |
| An allowed login (or a spoofed header, above) | Start Quests and approve their actions on every Kingdom: run commands as each Kingdom's user. Read every stored conversation. |
| A Quest on a Kingdom with Summons | Run commands on every machine in that Kingdom's `CRYSTAL_SUMMONS`, as its SSH user, through `summon` or by using the Kingdom's SSH key directly. To limit that, give the Kingdom a restricted key or a limited user on the target. |
| A node token | Pose as that one Kingdom to the hub: see the Quests started for it, send fake events into its sessions. Not reach other Kingdoms' sessions. Rotate with `scripts/airship-node-add.sh`; `DELETE /api/nodes/<id>` revokes it and cuts its connection. Both take effect without a hub restart. |
| A shell on a Kingdom as Crystal's user | Everything that user can already do, including running `claude` and answering Crystal's local permission port. Crystal adds no protection inside one user account. |
| The hub's disk or a backup | Every stored conversation, including any secret ever pasted into one. |
| A shell on the hub host | All of the above for the hub, plus serving a modified web app to users. |
| Control of the hub, on self-updating Kingdoms | Name a newer real release, which those Kingdoms would install. Not run its own code that way, and not move a Kingdom to an older release. It still has every power of an allowed login. |

## Self-updating Kingdoms

The hub tells a Kingdom only which version to run. That version has to fit a strict pattern, since it becomes part of a URL
and a folder name, and it has to be newer than the running one. The Kingdom fetches the package from this project's
GitHub Releases, then checks the attestation itself: Sigstore's signature, whose root comes through Sigstore's own
TUF repository, on a certificate naming `release.yml` in this repository at that version's own tag, over a statement
naming that exact file and digest. So one release can't pass as another, and the hub's package can't pass as the
Kingdom's. Nothing the hub says is part of the proof. Where the attestation came from doesn't matter either: the
release carries a copy, GitHub's API is the fallback, and both have to pass the same check.

What this doesn't cover:

- **Who can push a release tag.** Whoever can run the release workflow can publish a release that passes.
- **Dependencies.** The proof covers this project's package. `npm install` resolves its dependencies from npm at
  install time, by the ranges in the package, as `join` does. Install scripts are off, but a dependency's code still runs.
- **The first install.** `join` runs through `npx` from a URL and verifies nothing itself.

## What is out of scope

- A Kingdom user account that is already compromised (Crystal runs as that user and trusts it).
- Malicious allowed users: everyone on the allow list is fully trusted.
- The agent's own decisions within its permission mode. Pick the mode per Quest; `auto` lets it act without asking.
- Supply-chain attacks on dependencies (mitigated by a lockfile, Dependabot and CI scans, not prevented).

## Hardening checklist

1. Keep the hub behind `tailscale serve` only, with `AIRSHIP_ALLOWED_USERS` set to the fewest logins that need it.
2. One token per Kingdom; remove a Kingdom's token when you retire it.
3. Restrict the hub's disk and its backups like you would a password store: they hold full transcripts.
4. Don't paste secrets into chats. If you did, rotate the secret: deleting a Quest leaves copies in the backups until
   they rotate out ([what the hub stores](./HUB-DATA.md)).
5. Run each Kingdom's Crystal under a user that has only the access its Quests need.
6. Use Discreet or Off notifications on shared or lock-screen devices.

Report problems privately: see [`SECURITY.md`](../SECURITY.md).
