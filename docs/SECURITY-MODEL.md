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
| Browser → hub | `tailscale serve` (HTTPS, tailnet only) adds `Tailscale-User-Login`; the hub serves only logins in `AIRSHIP_ALLOWED_USERS`. The hub listens on 127.0.0.1 only, so nothing else on the network reaches it directly. |
| Kingdom → hub | Each Kingdom dials out with its own bearer token. The hub stores only a SHA-256 of each token (`AIRSHIP_NODES`), compares in constant time, and lets a node read and write only its own sessions. |
| New Kingdom → hub | An allowed user makes a one-time join code for a new name. `POST /api/join` trades it for that node's token, needs no login, and only exists to do this. A code has 128 random bits, lasts 10 minutes, works once, is kept as a hash in memory, and can't be made for a name that already has a token, so it can't take over a Kingdom. |
| Crystal → `claude` | The unmodified CLI under the machine's login. Crystal never reads, copies or relays Claude's credentials, and keeps its node token out of the sessions' environment. |
| `claude` → Crystal | The permission tool and hooks call Crystal on 127.0.0.1. Approvals are decided by the user in the web app; Crystal only relays them. |
| Hub at rest | SQLite on the hub's disk holds every event: prompts, replies, tool inputs and outputs, anything pasted. Nightly backups copy it. |
| Hub → phone | Web Push payloads are encrypted end to end to each browser; Discreet and Off levels keep titles and text out of them. |

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
| A node token | Pose as that one Kingdom to the hub: see the Quests started for it, send fake events into its sessions. Not reach other Kingdoms' sessions. Rotate with `scripts/airship-node-add.sh`; `DELETE /api/nodes/<id>` revokes it and cuts its connection. Both take effect without a hub restart. |
| A shell on a Kingdom as Crystal's user | Everything that user can already do, including running `claude` and answering Crystal's local permission port. Crystal adds no protection inside one user account. |
| The hub's disk or a backup | Every stored conversation, including any secret ever pasted into one. |
| A shell on the hub host | All of the above for the hub, plus serving a modified web app to users. |

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
   they rotate out (`docs/HUB-DATA.md`).
5. Run each Kingdom's Crystal under a user that has only the access its Quests need.
6. Use Discreet or Off notifications on shared or lock-screen devices.

Report problems privately: see `SECURITY.md`.
